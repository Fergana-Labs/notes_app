//! Reconcile-based capture. The desktop has out-of-band writers (the user, and
//! agents writing blocks.db directly), so we diff current rows against a
//! `sync_shadow` of per-row signatures and emit an op for whatever changed.
//! This captures direct DB writes for free and leaves `save_snapshot` alone.
//! `apply` updates the shadow as it writes, so a remote change isn't echoed
//! back as a local one.

use crate::error::Result;
use crate::parser;
use crate::sync::oplog::record_op;
use crate::sync::wire::{BlockPayload, DailyNotePayload, TagPayload};
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

fn sig_of<T: serde::Serialize>(payload: &T) -> Result<String> {
    Ok(parser::hash(&serde_json::to_string(payload)?))
}

/// One desired upsert: its op payload (as JSON) and signature.
struct Desired {
    payload: serde_json::Value,
    sig: String,
}

fn block_payload(conn: &Connection, id: &str) -> Result<Option<BlockPayload>> {
    let row = conn
        .query_row(
            "SELECT id, parent_id, position, heading, heading_level, content, content_hash, pinned, title, created_at, updated_at
             FROM blocks WHERE id = ?1 AND deleted_at IS NULL",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<u8>>(4)?,
                    r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?,
                    r.get::<_, i64>(7)?,
                    r.get::<_, Option<String>>(8)?,
                    r.get::<_, i64>(9)?,
                    r.get::<_, i64>(10)?,
                ))
            },
        )
        .ok();
    let Some((id, parent_id, position, heading, heading_level, content, content_hash, pinned, title, created_at, updated_at)) =
        row
    else {
        return Ok(None);
    };

    let mut tags: Vec<String> = conn
        .prepare("SELECT t.name FROM block_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.block_id = ?1")?
        .query_map(params![id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tags.sort();

    let mut scopes: Vec<String> = conn
        .prepare("SELECT scope FROM block_pins WHERE block_id = ?1")?
        .query_map(params![id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if pinned != 0 && !scopes.iter().any(|s| s.is_empty()) {
        scopes.push(String::new());
    }
    scopes.sort();
    scopes.dedup();

    Ok(Some(BlockPayload {
        id,
        parent_id,
        position,
        heading,
        heading_level,
        content,
        content_hash,
        title,
        tags,
        pinned_scopes: scopes,
        created_at,
        updated_at,
        ai_tags: None, // desktop AI-tag persistence lands in M6
    }))
}

fn desired_state(conn: &Connection) -> Result<HashMap<(String, String), Desired>> {
    let mut out: HashMap<(String, String), Desired> = HashMap::new();

    // Live blocks.
    let ids: Vec<String> = conn
        .prepare("SELECT id FROM blocks WHERE deleted_at IS NULL")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in ids {
        if let Some(p) = block_payload(conn, &id)? {
            let payload = serde_json::to_value(&p)?;
            out.insert(("block".into(), id), Desired { sig: sig_of(&p)?, payload });
        }
    }

    // Tags.
    let tags: Vec<TagPayload> = conn
        .prepare("SELECT name, description, sort_order, folder, priority FROM tags")?
        .query_map([], |r| {
            Ok(TagPayload {
                name: r.get(0)?,
                description: r.get(1)?,
                sort_order: r.get(2)?,
                folder: r.get(3)?,
                priority: r.get::<_, i64>(4)? != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for t in tags {
        let key = t.name.clone();
        let payload = serde_json::to_value(&t)?;
        out.insert(("tag".into(), key), Desired { sig: sig_of(&t)?, payload });
    }

    // Daily notes (never deleted).
    let dailies: Vec<DailyNotePayload> = conn
        .prepare("SELECT date, content, updated_at FROM daily_notes")?
        .query_map([], |r| {
            Ok(DailyNotePayload { date: r.get(0)?, content: r.get(1)?, updated_at: r.get(2)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for d in dailies {
        let key = d.date.clone();
        let payload = serde_json::to_value(&d)?;
        out.insert(("daily_note".into(), key), Desired { sig: sig_of(&d)?, payload });
    }

    Ok(out)
}

fn read_shadow(conn: &Connection) -> Result<HashMap<(String, String), String>> {
    let rows = conn
        .prepare("SELECT entity, entity_key, sig FROM sync_shadow")?
        .query_map([], |r| {
            Ok(((r.get::<_, String>(0)?, r.get::<_, String>(1)?), r.get::<_, String>(2)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().collect())
}

/// Diff current rows vs the shadow and emit ops for the changes. Returns the
/// number of ops emitted. Idempotent: a second call with no changes emits 0.
pub fn capture(conn: &mut Connection, device: &str) -> Result<usize> {
    let tx = conn.transaction()?;
    let desired = desired_state(&tx)?;
    let shadow = read_shadow(&tx)?;
    let mut emitted = 0;

    // Upserts: anything whose signature differs from the shadow.
    for ((entity, key), d) in &desired {
        if shadow.get(&(entity.clone(), key.clone())).map(String::as_str) == Some(d.sig.as_str()) {
            continue;
        }
        record_op(&tx, entity, key, "upsert", &d.payload, device)?;
        set_shadow(&tx, entity, key, &d.sig)?;
        emitted += 1;
    }

    // Deletes: block/tag keys that were synced but are gone now (soft-deleted,
    // purged, or removed). Daily notes are never deleted.
    let desired_keys: HashSet<(String, String)> = desired.keys().cloned().collect();
    for (key, _) in &shadow {
        if key.0 == "daily_note" {
            continue;
        }
        if !desired_keys.contains(key) {
            record_op(&tx, &key.0, &key.1, "delete", &serde_json::json!({ "key": key.1 }), device)?;
            tx.execute(
                "DELETE FROM sync_shadow WHERE entity = ?1 AND entity_key = ?2",
                params![key.0, key.1],
            )?;
            emitted += 1;
        }
    }

    tx.commit()?;
    Ok(emitted)
}

pub fn set_shadow(conn: &Connection, entity: &str, key: &str, sig: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_shadow(entity, entity_key, sig) VALUES(?1, ?2, ?3)
         ON CONFLICT(entity, entity_key) DO UPDATE SET sig = excluded.sig",
        params![entity, key, sig],
    )?;
    Ok(())
}

/// Recompute and store the shadow signature for a block after `apply` writes it
/// — echo suppression so the next `capture` doesn't re-emit the remote change.
pub fn refresh_block_shadow(conn: &Connection, id: &str) -> Result<()> {
    match block_payload(conn, id)? {
        Some(p) => set_shadow(conn, "block", id, &sig_of(&p)?)?,
        None => {
            conn.execute(
                "DELETE FROM sync_shadow WHERE entity = 'block' AND entity_key = ?1",
                params![id],
            )?;
        }
    }
    Ok(())
}

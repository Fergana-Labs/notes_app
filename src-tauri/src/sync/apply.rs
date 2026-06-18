//! Apply remote ops with deterministic LWW conflict resolution — mirror of
//! app/src/sync/apply.ts. An op is applied only if its HLC strictly beats the
//! row's current winner in `sync_row_meta`; either way it's marked in
//! `applied_ops` (idempotency). After writing, the row's `sync_shadow`
//! signature is refreshed so reconcile doesn't echo the change back.

use crate::db;
use crate::error::Result;
use crate::sync::hlc::{compare, tick_remote, Hlc};
use crate::sync::reconcile::{refresh_block_shadow, set_shadow};
use crate::sync::wire::{
    BlockPayload, CoachConversationPayload, CoachMessagePayload, DailyNotePayload, Op, TagPayload,
};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::collections::HashSet;

/// Apply one remote op. Returns true if it changed local data.
pub fn apply_remote_op(conn: &mut Connection, op: &Op) -> Result<bool> {
    let tx = conn.transaction()?;

    let seen: Option<String> = tx
        .query_row("SELECT op_id FROM applied_ops WHERE op_id = ?1", params![op.op_id], |r| r.get(0))
        .optional()?;
    if seen.is_some() {
        tx.commit()?;
        return Ok(false);
    }

    tick_remote(&tx, Hlc { wall: op.hlc_wall, counter: op.hlc_counter })?;

    let local: Option<(i64, i64, String)> = tx
        .query_row(
            "SELECT hlc_wall, hlc_counter, origin FROM sync_row_meta WHERE entity = ?1 AND entity_key = ?2",
            params![op.entity, op.entity_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;

    let wins = match &local {
        None => true,
        Some((lw, lc, lo)) => {
            compare(op.hlc_wall, op.hlc_counter, &op.origin, *lw, *lc, lo) == std::cmp::Ordering::Greater
        }
    };

    let mut changed = false;
    if wins {
        apply_data(&tx, op)?;
        tx.execute(
            "INSERT INTO sync_row_meta(entity, entity_key, hlc_wall, hlc_counter, origin)
             VALUES(?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(entity, entity_key) DO UPDATE SET
               hlc_wall = excluded.hlc_wall, hlc_counter = excluded.hlc_counter, origin = excluded.origin",
            params![op.entity, op.entity_key, op.hlc_wall, op.hlc_counter, op.origin],
        )?;
        changed = true;
    }

    tx.execute(
        "INSERT OR IGNORE INTO applied_ops(op_id, applied_at) VALUES(?1, ?2)",
        params![op.op_id, chrono::Utc::now().timestamp_millis()],
    )?;
    tx.commit()?;
    Ok(changed)
}

fn apply_data(tx: &Transaction, op: &Op) -> Result<()> {
    match op.entity.as_str() {
        "block" => {
            if op.op == "delete" {
                tx.execute(
                    "UPDATE blocks SET deleted_at = ?2 WHERE id = ?1",
                    params![op.entity_key, op.hlc_wall],
                )?;
                tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![op.entity_key])?;
                refresh_block_shadow(tx, &op.entity_key)?;
            } else if let Ok(p) = serde_json::from_value::<BlockPayload>(op.payload.clone()) {
                apply_block_upsert(tx, &p)?;
            }
        }
        "tag" => {
            if op.op == "delete" {
                apply_tag_delete(tx, &op.entity_key)?;
            } else if let Ok(p) = serde_json::from_value::<TagPayload>(op.payload.clone()) {
                apply_tag_upsert(tx, &p)?;
            }
        }
        "daily_note" => {
            if let Ok(p) = serde_json::from_value::<DailyNotePayload>(op.payload.clone()) {
                apply_daily_upsert(tx, &p)?;
            }
        }
        // Coach data authored by the relay — apply-only (never captured by
        // reconcile), so it just lands in the local mirror tables.
        "coach_conversation" => {
            if op.op == "delete" {
                // Drop the conversation and its messages from the local mirror.
                tx.execute("DELETE FROM coach_messages WHERE conversation_id = ?1", params![op.entity_key])?;
                tx.execute("DELETE FROM coach_conversations WHERE id = ?1", params![op.entity_key])?;
            } else if let Ok(p) = serde_json::from_value::<CoachConversationPayload>(op.payload.clone()) {
                tx.execute(
                    "INSERT INTO coach_conversations(id, title, is_default, system_prompt_note_id, created_at, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                       title=excluded.title, is_default=excluded.is_default,
                       system_prompt_note_id=excluded.system_prompt_note_id, updated_at=excluded.updated_at",
                    params![p.id, p.title, p.is_default as i64, p.system_prompt_note_id, p.created_at, p.updated_at],
                )?;
            }
        }
        "coach_message" => {
            if let Ok(p) = serde_json::from_value::<CoachMessagePayload>(op.payload.clone()) {
                // Append-only; ignore a duplicate id (idempotent re-apply).
                tx.execute(
                    "INSERT OR IGNORE INTO coach_messages(id, conversation_id, role, text, audio_clip_id, created_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                    params![p.id, p.conversation_id, p.role, p.text, p.audio_clip_id, p.created_at],
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn apply_block_upsert(tx: &Transaction, p: &BlockPayload) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute(
        "INSERT INTO blocks(id, parent_id, position, heading, heading_level, content, content_hash, pinned, title, created_at, updated_at, deleted_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, NULL)
         ON CONFLICT(id) DO UPDATE SET
           parent_id=excluded.parent_id, position=excluded.position, heading=excluded.heading,
           heading_level=excluded.heading_level, content=excluded.content, content_hash=excluded.content_hash,
           pinned=0, title=excluded.title, created_at=excluded.created_at, updated_at=excluded.updated_at,
           deleted_at=NULL",
        params![
            p.id, p.parent_id, p.position, p.heading, p.heading_level, p.content, p.content_hash,
            p.title, p.created_at, p.updated_at
        ],
    )?;

    // Rewrite tag edges from the payload's final set (synced by NAME).
    tx.execute("DELETE FROM block_tags WHERE block_id = ?1", params![p.id])?;
    for name in &p.tags {
        let tag_id = db::upsert_tag(tx, name, now)?;
        tx.execute(
            "INSERT OR IGNORE INTO block_tags(block_id, tag_id) VALUES(?1, ?2)",
            params![p.id, tag_id],
        )?;
    }

    // Rewrite AI-tag provenance from the payload (which tags came from the AI tagger).
    tx.execute("DELETE FROM block_ai_tags WHERE block_id = ?1", params![p.id])?;
    if let Some(ai) = &p.ai_tags {
        for name in ai {
            tx.execute(
                "INSERT OR IGNORE INTO block_ai_tags(block_id, name) VALUES(?1, ?2)",
                params![p.id, name],
            )?;
        }
    }

    // Rewrite pins.
    tx.execute("DELETE FROM block_pins WHERE block_id = ?1", params![p.id])?;
    let mut seen: HashSet<String> = HashSet::new();
    for scope in &p.pinned_scopes {
        let s = scope.trim().to_string();
        if !seen.insert(s.clone()) {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO block_pins(block_id, scope) VALUES(?1, ?2)",
            params![p.id, s],
        )?;
    }

    // Keep the version trail (loser content retained from prior saves).
    tx.execute(
        "INSERT OR IGNORE INTO block_versions(block_id, content_hash, content, parent_hash, edited_at, source)
         VALUES(?1, ?2, ?3, NULL, ?4, 'sync')",
        params![p.id, p.content_hash, p.content, p.updated_at],
    )?;

    db::refresh_fts_row(tx, &p.id)?;
    refresh_block_shadow(tx, &p.id)?;
    Ok(())
}

fn apply_tag_upsert(tx: &Transaction, p: &TagPayload) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let name = p.name.to_lowercase();
    tx.execute(
        "INSERT INTO tags(name, description, sort_order, folder, priority, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(name) DO UPDATE SET
           description=excluded.description, sort_order=excluded.sort_order,
           folder=excluded.folder, priority=excluded.priority, updated_at=excluded.updated_at",
        params![name, p.description, p.sort_order, p.folder, p.priority as i64, now],
    )?;
    let sig = crate::parser::hash(&serde_json::to_string(p)?);
    set_shadow(tx, "tag", &name, &sig)?;
    Ok(())
}

fn apply_tag_delete(tx: &Transaction, name: &str) -> Result<()> {
    let lname = name.to_lowercase();
    let affected: Vec<String> = tx
        .prepare("SELECT bt.block_id FROM block_tags bt JOIN tags t ON t.id = bt.tag_id WHERE t.name = ?1")?
        .query_map(params![lname], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tx.execute("DELETE FROM tags WHERE name = ?1", params![lname])?;
    for id in affected {
        db::refresh_fts_row(tx, &id)?;
        refresh_block_shadow(tx, &id)?;
    }
    tx.execute("DELETE FROM sync_shadow WHERE entity = 'tag' AND entity_key = ?1", params![lname])?;
    Ok(())
}

fn apply_daily_upsert(tx: &Transaction, p: &DailyNotePayload) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    tx.execute(
        "INSERT INTO daily_notes(date, content, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(date) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at",
        params![p.date, p.content, now, p.updated_at],
    )?;
    let sig = crate::parser::hash(&serde_json::to_string(p)?);
    set_shadow(tx, "daily_note", &p.date, &sig)?;
    Ok(())
}

//! Local op recording + push/pull cursors. Mirrors app/src/sync/oplog.ts and
//! the sync_state handling in client.ts.

use crate::error::Result;
use crate::sync::hlc::tick_local;
use crate::sync::wire::Op;
use rusqlite::{params, Connection, OptionalExtension};
use ulid::Ulid;

pub fn ensure_meta(conn: &Connection, key: &str, make: impl FnOnce() -> String) -> Result<()> {
    let exists: Option<String> = conn
        .query_row("SELECT value FROM sync_meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?;
    if exists.is_none() {
        conn.execute("INSERT INTO sync_meta(key, value) VALUES(?1, ?2)", params![key, make()])?;
    }
    Ok(())
}

pub fn get_meta(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM sync_meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()?)
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

pub fn device_id(conn: &Connection) -> Result<String> {
    get_meta(conn, "device_id")?
        .ok_or_else(|| crate::error::AppError::Other("device_id not initialized".into()))
}

/// Record a locally-captured mutation: stamp an HLC, append to sync_oplog (the
/// durable push queue), and update the per-row LWW register.
pub fn record_op(
    conn: &Connection,
    entity: &str,
    entity_key: &str,
    op: &str,
    payload: &serde_json::Value,
    origin: &str,
) -> Result<()> {
    let hlc = tick_local(conn)?;
    let op_id = Ulid::new().to_string();
    let payload_text = serde_json::to_string(payload)?;
    conn.execute(
        "INSERT INTO sync_oplog(op_id, entity, entity_key, op, payload, hlc_wall, hlc_counter, origin)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![op_id, entity, entity_key, op, payload_text, hlc.wall, hlc.counter, origin],
    )?;
    conn.execute(
        "INSERT INTO sync_row_meta(entity, entity_key, hlc_wall, hlc_counter, origin)
         VALUES(?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(entity, entity_key) DO UPDATE SET
           hlc_wall = excluded.hlc_wall, hlc_counter = excluded.hlc_counter, origin = excluded.origin",
        params![entity, entity_key, hlc.wall, hlc.counter, origin],
    )?;
    Ok(())
}

/// Ops authored locally that the peer cursor hasn't acked yet.
pub fn pending_ops(conn: &Connection, device: &str, since_seq: i64, limit: i64) -> Result<(Vec<Op>, i64)> {
    let mut stmt = conn.prepare(
        "SELECT seq, op_id, entity, entity_key, op, payload, hlc_wall, hlc_counter, origin
         FROM sync_oplog WHERE origin = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3",
    )?;
    let mut max_seq = since_seq;
    let rows = stmt
        .query_map(params![device, since_seq, limit], |r| {
            let seq: i64 = r.get(0)?;
            let payload_text: String = r.get(5)?;
            Ok((
                seq,
                Op {
                    op_id: r.get(1)?,
                    entity: r.get(2)?,
                    entity_key: r.get(3)?,
                    op: r.get(4)?,
                    payload: serde_json::from_str(&payload_text).unwrap_or(serde_json::Value::Null),
                    hlc_wall: r.get(6)?,
                    hlc_counter: r.get(7)?,
                    origin: r.get(8)?,
                },
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut ops = Vec::with_capacity(rows.len());
    for (seq, op) in rows {
        if seq > max_seq {
            max_seq = seq;
        }
        ops.push(op);
    }
    Ok((ops, max_seq))
}

// --- per-peer cursors (sync_state) ------------------------------------------

pub fn push_cursor(conn: &Connection, peer: &str) -> Result<i64> {
    Ok(conn
        .query_row("SELECT push_cursor FROM sync_state WHERE peer = ?1", params![peer], |r| r.get(0))
        .optional()?
        .unwrap_or(0))
}

pub fn pull_cursor(conn: &Connection, peer: &str) -> Result<String> {
    Ok(conn
        .query_row("SELECT pull_cursor FROM sync_state WHERE peer = ?1", params![peer], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

pub fn set_push_cursor(conn: &Connection, peer: &str, cursor: i64) -> Result<()> {
    let pull = pull_cursor(conn, peer)?;
    upsert_state(conn, peer, cursor, &pull)
}

pub fn set_pull_cursor(conn: &Connection, peer: &str, cursor: &str) -> Result<()> {
    let push = push_cursor(conn, peer)?;
    upsert_state(conn, peer, push, cursor)
}

fn upsert_state(conn: &Connection, peer: &str, push: i64, pull: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_state(peer, push_cursor, pull_cursor, updated_at) VALUES(?1, ?2, ?3, ?4)
         ON CONFLICT(peer) DO UPDATE SET push_cursor=excluded.push_cursor, pull_cursor=excluded.pull_cursor, updated_at=excluded.updated_at",
        params![peer, push, pull, chrono::Utc::now().timestamp_millis()],
    )?;
    Ok(())
}

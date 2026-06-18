//! Offline-first sync for the desktop, a Rust port of the mobile engine
//! (stash_app/app/src/sync). Same wire protocol, HLC rules, and LWW conflict
//! resolution, so desktop and phone converge through the same relay.
//!
//! Capture differs from mobile: the desktop has out-of-band writers (the user
//! editing, plus agents writing blocks.db directly), so instead of recording an
//! op on every edit we diff current rows against a `sync_shadow` of per-row
//! signatures and emit ops for whatever changed. That captures direct DB writes
//! for free and leaves `save_snapshot` untouched. `apply` updates the shadow as
//! it writes, which suppresses echoing a remote change back as a local one.

pub mod apply;
pub mod client;
pub mod commands;
pub mod hlc;
pub mod oplog;
pub mod reconcile;
pub mod wire;

#[cfg(test)]
mod tests;

use crate::error::Result;
use rusqlite::Connection;

/// Sync tables, layered additively on the core schema (mirror of the mobile
/// SYNC_SCHEMA, plus `sync_shadow` for desktop reconcile-based capture).
const SYNC_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sync_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_oplog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,
  entity TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  hlc_wall INTEGER NOT NULL,
  hlc_counter INTEGER NOT NULL,
  origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_row_meta (
  entity TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  hlc_wall INTEGER NOT NULL,
  hlc_counter INTEGER NOT NULL,
  origin TEXT NOT NULL,
  PRIMARY KEY (entity, entity_key)
);
CREATE TABLE IF NOT EXISTS applied_ops (
  op_id TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_state (
  peer TEXT PRIMARY KEY,
  push_cursor INTEGER NOT NULL DEFAULT 0,
  pull_cursor TEXT NOT NULL DEFAULT '',
  updated_at INTEGER
);
-- Per-row signature of the last-synced state. Reconcile diffs current rows
-- against this to find local changes (including agents' direct writes).
CREATE TABLE IF NOT EXISTS sync_shadow (
  entity TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  sig TEXT NOT NULL,
  PRIMARY KEY (entity, entity_key)
);
"#;

/// Apply the sync tables and ensure this device has a stable id + clock seed.
pub fn apply_sync_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(SYNC_SCHEMA)?;
    oplog::ensure_meta(conn, "device_id", || ulid::Ulid::new().to_string())?;
    oplog::ensure_meta(conn, "hlc_wall", || "0".to_string())?;
    oplog::ensure_meta(conn, "hlc_counter", || "0".to_string())?;
    Ok(())
}

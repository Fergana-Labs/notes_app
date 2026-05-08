use crate::error::{AppError, Result};
use crate::parser;
use chrono::{DateTime, Local, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 3;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  position INTEGER NOT NULL,
  heading TEXT,
  heading_level INTEGER,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tags TEXT NOT NULL,
  manual_tags INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blocks_position ON blocks(position);
CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id);

CREATE TABLE IF NOT EXISTS block_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_hash TEXT,
  edited_at INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_versions_block ON block_versions(block_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_versions_block_hash ON block_versions(block_id, content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
  id UNINDEXED, content, tags, heading
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

pub fn open(workspace: &Path) -> Result<Connection> {
    let dir = workspace.join(".notesapp");
    std::fs::create_dir_all(&dir)?;
    let conn = Connection::open(dir.join("blocks.db"))?;
    // WAL lets external writers (agents) write while the app reads, and vice
    // versa, without serializing every operation through a single lock.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredBlock {
    pub id: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub heading: Option<String>,
    pub heading_level: Option<u8>,
    pub content: String,
    pub content_hash: String,
    pub tags: Vec<String>,
    pub manual_tags: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input for create / save block operations. Position, parent_id, heading and
/// heading_level are computed by the editor (which has the structural view of
/// the doc); content_hash and tags are derived server-side.
#[derive(Debug, Clone, Deserialize)]
pub struct BlockInput {
    pub id: String,
    pub content: String,
    pub position: i64,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub heading: Option<String>,
    #[serde(default)]
    pub heading_level: Option<u8>,
}

pub fn list_blocks(conn: &Connection) -> Result<Vec<StoredBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, position, heading, heading_level, content, content_hash, tags, manual_tags, created_at, updated_at FROM blocks ORDER BY position",
    )?;
    let rows = stmt
        .query_map([], row_to_block)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<StoredBlock>> {
    let needle = format!("\"{}\"", tag.to_lowercase());
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, position, heading, heading_level, content, content_hash, tags, manual_tags, created_at, updated_at FROM blocks WHERE instr(tags, ?1) > 0 ORDER BY position",
    )?;
    let rows = stmt
        .query_map(params![needle], row_to_block)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
}

pub fn list_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    let mut stmt = conn.prepare(
        "SELECT je.value AS tag, COUNT(*) AS c FROM blocks, json_each(blocks.tags) je GROUP BY tag ORDER BY c DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TagCount {
                tag: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub id: String,
    pub heading: Option<String>,
    pub snippet: String,
}

pub fn search(conn: &Connection, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let q = sanitize_fts_query(query);
    let mut stmt = conn.prepare(
        "SELECT b.id, b.heading, snippet(blocks_fts, 1, '<mark>', '</mark>', '…', 12) AS snip
         FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.id
         WHERE blocks_fts MATCH ?1 ORDER BY rank LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![q, limit], |row| {
            Ok(SearchHit {
                id: row.get(0)?,
                heading: row.get(1)?,
                snippet: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn sanitize_fts_query(q: &str) -> String {
    let tokens: Vec<String> = q
        .split_whitespace()
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        return String::new();
    }
    let mut out = tokens.join(" ");
    out.push('*');
    out
}

/// Save a snapshot of the document's blocks. The caller (the editor) provides:
///   - `blocks` — every block currently in the document, in order
///   - `deleted_ids` — IDs that existed but no longer do (e.g. user pressed
///     Backspace to merge two blocks)
///
/// The server:
///   - UPSERTs each input block, writing FTS + a `block_versions` row only when
///     the content_hash actually changed (so unchanged rows are cheap and don't
///     bloat the version table).
///   - DELETEs any blocks listed in `deleted_ids` (and their FTS rows).
///   - Honors `manual_tags`: if a block has `manual_tags=1`, its `tags` column
///     is preserved; otherwise tags are re-extracted from content inline.
///
/// Returns the list of block IDs whose content actually changed (the editor
/// uses this for nothing today, but it's useful for downstream listeners
/// like a future re-indexer or agent).
pub fn save_snapshot(
    conn: &mut Connection,
    blocks: &[BlockInput],
    deleted_ids: &[String],
    source: &str,
) -> Result<Vec<String>> {
    let now = Utc::now().timestamp_millis();
    let tx = conn.transaction()?;

    let mut changed: Vec<String> = Vec::new();

    for b in blocks {
        let prior: Option<(String, i64)> = tx
            .query_row(
                "SELECT content_hash, created_at FROM blocks WHERE id = ?1",
                params![b.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        let new_hash = parser::hash(&b.content);
        let extracted = parser::extract_hashtags(&b.content);
        let tags_json = serde_json::to_string(&extracted)?;

        // Tags are always derived from inline content. The legacy
        // `manual_tags` column is forced back to 0 on every save so blocks
        // marked manual by old code paths heal automatically.
        let manual_tags: i64 = 0;
        let (created_at, content_changed, parent_hash) = match prior {
            Some((prior_hash, created)) => {
                let changed_now = prior_hash != new_hash;
                (created, changed_now, Some(prior_hash))
            }
            None => (now, true, None),
        };

        tx.execute(
            "INSERT INTO blocks(id, parent_id, position, heading, heading_level, content, content_hash, tags, manual_tags, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
               parent_id=excluded.parent_id,
               position=excluded.position,
               heading=excluded.heading,
               heading_level=excluded.heading_level,
               content=excluded.content,
               content_hash=excluded.content_hash,
               tags=excluded.tags,
               manual_tags=excluded.manual_tags,
               updated_at=CASE WHEN blocks.content_hash=excluded.content_hash
                               AND blocks.position=excluded.position
                               AND blocks.parent_id IS excluded.parent_id
                               AND blocks.heading IS excluded.heading
                               AND blocks.heading_level IS excluded.heading_level
                          THEN blocks.updated_at ELSE excluded.updated_at END",
            params![
                b.id,
                b.parent_id,
                b.position,
                b.heading,
                b.heading_level,
                b.content,
                new_hash,
                tags_json,
                manual_tags,
                created_at,
                now,
            ],
        )?;

        if content_changed {
            // FTS sync
            tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![b.id])?;
            tx.execute(
                "INSERT INTO blocks_fts(id, content, tags, heading) VALUES(?1, ?2, ?3, ?4)",
                params![
                    b.id,
                    b.content,
                    extracted.join(" "),
                    b.heading.clone().unwrap_or_default()
                ],
            )?;

            tx.execute(
                "INSERT OR IGNORE INTO block_versions(block_id, content_hash, content, parent_hash, edited_at, source)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![b.id, new_hash, b.content, parent_hash, now, source],
            )?;
            changed.push(b.id.clone());
        }
    }

    for id in deleted_ids {
        tx.execute("DELETE FROM blocks WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![id])?;
    }

    tx.commit()?;
    Ok(changed)
}

/// One-shot migration: clear the legacy `manual_tags=1` flag on every block
/// and recompute the `tags` column from the block's inline content. Also
/// rebuilds the FTS row so search reflects the (possibly newly-extracted)
/// tag list. Used by the v2 → v3 schema upgrade.
pub fn heal_manual_tags(conn: &mut Connection) -> Result<()> {
    let tx = conn.transaction()?;
    let rows: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT id, content FROM blocks")?;
        let collected: rusqlite::Result<Vec<_>> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect();
        collected?
    };
    for (id, content) in rows {
        let extracted = parser::extract_hashtags(&content);
        let tags_json = serde_json::to_string(&extracted)?;
        tx.execute(
            "UPDATE blocks SET tags = ?1, manual_tags = 0 WHERE id = ?2",
            params![tags_json, id],
        )?;
        tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![id])?;
        tx.execute(
            "INSERT INTO blocks_fts(id, content, tags, heading)
             SELECT id, content, ?1, COALESCE(heading, '') FROM blocks WHERE id = ?2",
            params![extracted.join(" "), id],
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn list_versions(conn: &Connection, block_id: &str) -> Result<Vec<BlockVersion>> {
    let mut stmt = conn.prepare(
        "SELECT id, block_id, content_hash, content, parent_hash, edited_at, source
         FROM block_versions WHERE block_id = ?1 ORDER BY edited_at DESC",
    )?;
    let rows = stmt
        .query_map(params![block_id], |row| {
            Ok(BlockVersion {
                id: row.get(0)?,
                block_id: row.get(1)?,
                content_hash: row.get(2)?,
                content: row.get(3)?,
                parent_hash: row.get(4)?,
                edited_at: row.get(5)?,
                source: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
pub struct BlockVersion {
    pub id: i64,
    pub block_id: String,
    pub content_hash: String,
    pub content: String,
    pub parent_hash: Option<String>,
    pub edited_at: i64,
    pub source: String,
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn row_to_block(row: &rusqlite::Row) -> rusqlite::Result<StoredBlock> {
    let tags_json: String = row.get(7)?;
    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
    let heading_level: Option<i64> = row.get(4)?;
    let manual_tags: i64 = row.get(8)?;
    Ok(StoredBlock {
        id: row.get(0)?,
        parent_id: row.get(1)?,
        position: row.get(2)?,
        heading: row.get(3)?,
        heading_level: heading_level.map(|l| l as u8),
        content: row.get(5)?,
        content_hash: row.get(6)?,
        tags,
        manual_tags: manual_tags != 0,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

// =========================================================================
// Backups
// =========================================================================

#[derive(Debug, Serialize)]
pub struct BackupInfo {
    pub name: String,
    pub timestamp: i64,
    pub size_bytes: u64,
}

fn backups_dir(workspace: &Path) -> PathBuf {
    workspace.join(".notesapp").join("backups")
}

/// Take an online consistent snapshot of `blocks.db` to
/// `.notesapp/backups/blocks-YYYY-MM-DD-HHMMSS.db`. Safe to run while writes
/// are happening — `rusqlite::backup::Backup` walks the live DB pages without
/// blocking writers (in WAL mode).
pub fn backup(conn: &Connection, workspace: &Path) -> Result<BackupInfo> {
    let dir = backups_dir(workspace);
    std::fs::create_dir_all(&dir)?;
    let now: DateTime<Local> = Local::now();
    let name = format!("blocks-{}.db", now.format("%Y-%m-%d-%H%M%S"));
    let path = dir.join(&name);
    let mut dst = Connection::open(&path)?;
    {
        let backup = rusqlite::backup::Backup::new(conn, &mut dst)?;
        backup.run_to_completion(64, std::time::Duration::from_millis(0), None)?;
    }
    let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(BackupInfo {
        name,
        timestamp: now.timestamp(),
        size_bytes,
    })
}

pub fn list_backups(workspace: &Path) -> Result<Vec<BackupInfo>> {
    let dir = backups_dir(workspace);
    if !dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out: Vec<BackupInfo> = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("blocks-") || !name.ends_with(".db") {
            continue;
        }
        let stem = name
            .strip_prefix("blocks-")
            .and_then(|s| s.strip_suffix(".db"))
            .unwrap_or("");
        let ts = parse_backup_timestamp(stem).unwrap_or(0);
        let size_bytes = entry.metadata()?.len();
        out.push(BackupInfo {
            name,
            timestamp: ts,
            size_bytes,
        });
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(out)
}

fn parse_backup_timestamp(stem: &str) -> Option<i64> {
    // Stem looks like "2026-04-30-091422".
    let parsed = chrono::NaiveDateTime::parse_from_str(stem, "%Y-%m-%d-%H%M%S").ok()?;
    let local = Local
        .from_local_datetime(&parsed)
        .single()
        .or_else(|| Local.from_local_datetime(&parsed).earliest())?;
    Some(local.timestamp())
}

/// Replace `blocks.db` with the named backup. Caller must reopen the DB
/// connection afterwards (the AppState handles this).
pub fn restore_backup(workspace: &Path, name: &str) -> Result<()> {
    let dir = backups_dir(workspace);
    let src = dir.join(name);
    if !src.is_file() {
        return Err(AppError::Other(format!("backup not found: {name}")));
    }
    // Sanity check: open it as SQLite and verify it has a `blocks` table.
    {
        let probe = Connection::open(&src)?;
        let count: i64 = probe.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='blocks'",
            [],
            |row| row.get(0),
        )?;
        if count == 0 {
            return Err(AppError::Other(format!(
                "backup file {name} is not a Mochi database"
            )));
        }
    }
    let dst = workspace.join(".notesapp").join("blocks.db");
    // Copy over (as opposed to rename) so a partial failure leaves the live
    // file recoverable. Caller will reopen the connection on the new file.
    std::fs::copy(&src, &dst)?;
    // Drop sidecar WAL/SHM if present — they belong to the previous live DB.
    let _ = std::fs::remove_file(workspace.join(".notesapp").join("blocks.db-wal"));
    let _ = std::fs::remove_file(workspace.join(".notesapp").join("blocks.db-shm"));
    Ok(())
}

/// Keep at most `keep` most-recent backups. Deletes the rest.
pub fn prune_backups(workspace: &Path, keep: usize) -> Result<usize> {
    let dir = backups_dir(workspace);
    let entries = list_backups(workspace)?;
    if entries.len() <= keep {
        return Ok(0);
    }
    let mut removed = 0;
    for e in entries.iter().skip(keep) {
        let _ = std::fs::remove_file(dir.join(&e.name));
        removed += 1;
    }
    Ok(removed)
}

/// Should we run an automatic backup right now? True if no backup exists for
/// the current local-day yet.
pub fn should_backup(workspace: &Path) -> Result<bool> {
    let backups = list_backups(workspace)?;
    if backups.is_empty() {
        return Ok(true);
    }
    let today = Local::now().date_naive();
    let latest_day = DateTime::<Utc>::from_timestamp(backups[0].timestamp, 0)
        .map(|d| d.with_timezone(&Local).date_naive());
    Ok(latest_day != Some(today))
}

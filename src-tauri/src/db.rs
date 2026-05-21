use crate::error::{AppError, Result};
use crate::parser;
use chrono::{DateTime, Local, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 5;

// New-install schema. Pre-v5 workspaces are reshaped to this via the
// v5 migration in state::migrate_if_needed (and `heal_strip_inline_tags`
// in this file). The migration is responsible for moving rows from the
// old shape into the new tables and dropping the legacy columns —
// CREATE IF NOT EXISTS here is only the path for brand-new workspaces.
const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  position INTEGER NOT NULL,
  heading TEXT,
  heading_level INTEGER,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
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

-- Normalized tags: one row per distinct tag. Replaces the legacy
-- `tag_metadata` table (which was a partial overlay on JSON-array
-- tags stored on blocks). `name` is always lowercased.
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER,
  folder TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Many-to-many join: which blocks carry which tags. FK cascades clear
-- this row when either side is deleted.
CREATE TABLE IF NOT EXISTS block_tags (
  block_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (block_id, tag_id),
  FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag_id);
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
    // Idempotent column add for existing v4 workspaces that haven't
    // yet hit the v5 migration (or were created at v5+ but missed the
    // `pinned` column for some reason). ALTER TABLE silently no-ops
    // on duplicate column.
    add_column_if_missing(&conn, "blocks", "pinned", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(conn)
}

/// Add a column if it doesn't already exist. Catches the
/// "duplicate column name" sqlite error and treats it as success.
/// Used in place of versioned migrations for additive schema changes.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    column_type: &str,
) -> Result<()> {
    let sql = format!("ALTER TABLE {} ADD COLUMN {} {}", table, column, column_type);
    match conn.execute(&sql, []) {
        Ok(_) => Ok(()),
        Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.contains("duplicate column name") =>
        {
            Ok(())
        }
        Err(e) => Err(e.into()),
    }
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
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input for create / save block operations. Position, parent_id, heading and
/// heading_level are computed by the editor (which has the structural view of
/// the doc). `tags` is optional — when present, those names are merged with
/// content-extracted hashtags and become the block's final tag set.
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
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub pinned: Option<bool>,
}

/// Read every block's joined tag list in one query. Returns a map from
/// block_id → sorted lowercase tag names. Used by `list_blocks` (and
/// `SaveResult` builders) to avoid an N+1 per-block join.
fn fetch_block_tags(conn: &Connection) -> Result<std::collections::HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT bt.block_id, t.name FROM block_tags bt
         JOIN tags t ON t.id = bt.tag_id
         ORDER BY bt.block_id, t.name",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for (block_id, name) in rows {
        out.entry(block_id).or_default().push(name);
    }
    Ok(out)
}

pub fn list_blocks(conn: &Connection) -> Result<Vec<StoredBlock>> {
    let tag_map = fetch_block_tags(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id, parent_id, position, heading, heading_level, content, content_hash, pinned, created_at, updated_at FROM blocks ORDER BY position",
    )?;
    let rows = stmt
        .query_map([], |row| row_to_block(row, &tag_map))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_blocks_by_tag(conn: &Connection, tag: &str) -> Result<Vec<StoredBlock>> {
    let tag_map = fetch_block_tags(conn)?;
    let needle = tag.to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT b.id, b.parent_id, b.position, b.heading, b.heading_level, b.content, b.content_hash, b.pinned, b.created_at, b.updated_at
         FROM blocks b
         JOIN block_tags bt ON bt.block_id = b.id
         JOIN tags t ON t.id = bt.tag_id
         WHERE t.name = ?1
         ORDER BY b.position",
    )?;
    let rows = stmt
        .query_map(params![needle], |row| row_to_block(row, &tag_map))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

#[derive(Debug, Serialize)]
pub struct TagCount {
    pub tag: String,
    pub count: i64,
    pub description: String,
    pub sort_order: Option<i64>,
    pub folder: Option<String>,
}

pub fn list_tags(conn: &Connection) -> Result<Vec<TagCount>> {
    // Single join against the normalized tag tables. Counts come from
    // `block_tags` directly. Ordering: explicit `sort_order` first (in
    // that order); the rest fall back to count DESC, then alphabetical.
    let mut stmt = conn.prepare(
        "SELECT t.name,
                COUNT(bt.block_id) AS c,
                t.description,
                t.sort_order,
                t.folder
         FROM tags t
         LEFT JOIN block_tags bt ON bt.tag_id = t.id
         GROUP BY t.id
         ORDER BY CASE WHEN t.sort_order IS NULL THEN 1 ELSE 0 END,
                  t.sort_order ASC,
                  c DESC,
                  t.name ASC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(TagCount {
                tag: row.get(0)?,
                count: row.get(1)?,
                description: row.get(2)?,
                sort_order: row.get(3)?,
                folder: row.get(4)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Upsert a tag row by name. Returns the tag's primary key. Used when
/// new content introduces a tag name we haven't seen before. Created
/// rows have empty description / NULL sort_order / NULL folder.
fn upsert_tag(tx: &rusqlite::Transaction, name: &str, now: i64) -> Result<i64> {
    tx.execute(
        "INSERT INTO tags(name, description, sort_order, folder, created_at, updated_at)
         VALUES(?1, '', NULL, NULL, ?2, ?2)
         ON CONFLICT(name) DO NOTHING",
        params![name, now],
    )?;
    let id: i64 = tx.query_row(
        "SELECT id FROM tags WHERE name = ?1",
        params![name],
        |r| r.get(0),
    )?;
    Ok(id)
}

/// Move a tag into a folder (or to the root by passing `None`).
/// Folders are organization-only: a UI grouping in the sidebar.
pub fn set_tag_folder(conn: &Connection, name: &str, folder: Option<&str>) -> Result<()> {
    let now = Utc::now().timestamp_millis();
    let lname = name.to_lowercase();
    conn.execute(
        "INSERT INTO tags(name, description, sort_order, folder, created_at, updated_at)
         VALUES(?1, '', NULL, ?2, ?3, ?3)
         ON CONFLICT(name) DO UPDATE SET
           folder = excluded.folder,
           updated_at = excluded.updated_at",
        params![lname, folder, now],
    )?;
    Ok(())
}

/// Upsert a user-visible description for `name`. Empty string is a
/// valid "no description" value (vs deleting the row), since we want
/// to preserve sort_order through description edits.
pub fn set_tag_description(conn: &Connection, name: &str, description: &str) -> Result<()> {
    let now = Utc::now().timestamp_millis();
    let lname = name.to_lowercase();
    conn.execute(
        "INSERT INTO tags(name, description, sort_order, folder, created_at, updated_at)
         VALUES(?1, ?2, NULL, NULL, ?3, ?3)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           updated_at = excluded.updated_at",
        params![lname, description, now],
    )?;
    Ok(())
}

/// Replace the sort order across a list of tags. `names` is the new
/// order, 1-indexed. Tags not in the list keep their existing order
/// (or remain unranked if they have no sort_order yet).
pub fn reorder_tags(conn: &mut Connection, names: &[String]) -> Result<()> {
    let now = Utc::now().timestamp_millis();
    let tx = conn.transaction()?;
    for (idx, name) in names.iter().enumerate() {
        let order = (idx as i64) + 1;
        let lname = name.to_lowercase();
        tx.execute(
            "INSERT INTO tags(name, description, sort_order, folder, created_at, updated_at)
             VALUES(?1, '', ?2, NULL, ?3, ?3)
             ON CONFLICT(name) DO UPDATE SET
               sort_order = excluded.sort_order,
               updated_at = excluded.updated_at",
            params![lname, order, now],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Delete a tag globally. Two modes:
///   - "strip": detach the tag from every block that carries it. The
///     tag's row in `tags` is removed; blocks keep their content.
///   - "delete_blocks": drop every block that carries the tag.
/// FK cascades clear `block_tags` rows automatically when either side
/// is removed.
pub fn delete_tag(
    conn: &mut Connection,
    name: &str,
    mode: &str,
) -> Result<Vec<String>> {
    let lname = name.to_lowercase();
    let tx = conn.transaction()?;

    let affected_ids: Vec<String> = {
        let mut stmt = tx.prepare(
            "SELECT bt.block_id FROM block_tags bt
             JOIN tags t ON t.id = bt.tag_id
             WHERE t.name = ?1",
        )?;
        let ids: rusqlite::Result<Vec<String>> = stmt
            .query_map(params![lname], |r| r.get::<_, String>(0))?
            .collect();
        ids?
    };

    match mode {
        "strip" => {
            // FK cascade clears block_tags entries when the tags row is
            // removed. Block content stays untouched (no inline `#tag`
            // text lives there anymore post-v5).
            tx.execute("DELETE FROM tags WHERE name = ?1", params![lname])?;
            // FTS rows still mention the old tag name. Refresh them.
            for id in &affected_ids {
                refresh_fts_row(&tx, id)?;
            }
        }
        "delete_blocks" => {
            for id in &affected_ids {
                tx.execute("DELETE FROM blocks WHERE id = ?1", params![id])?;
                tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![id])?;
            }
            tx.execute("DELETE FROM tags WHERE name = ?1", params![lname])?;
        }
        _ => {
            return Err(AppError::Other(format!("unknown delete_tag mode: {mode}")));
        }
    }

    tx.commit()?;
    Ok(affected_ids)
}

/// Rebuild `blocks_fts` for one block from the current `blocks` +
/// joined tag names. Caller is responsible for surrounding transaction.
fn refresh_fts_row(tx: &rusqlite::Transaction, block_id: &str) -> Result<()> {
    let row: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT content, heading FROM blocks WHERE id = ?1",
            params![block_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (content, heading) = match row {
        Some(r) => r,
        None => return Ok(()), // block was deleted
    };
    let tag_names: String = {
        let mut stmt = tx.prepare(
            "SELECT t.name FROM block_tags bt
             JOIN tags t ON t.id = bt.tag_id
             WHERE bt.block_id = ?1
             ORDER BY t.name",
        )?;
        let names: rusqlite::Result<Vec<String>> = stmt
            .query_map(params![block_id], |r| r.get::<_, String>(0))?
            .collect();
        names?.join(" ")
    };
    tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![block_id])?;
    tx.execute(
        "INSERT INTO blocks_fts(id, content, tags, heading) VALUES(?1, ?2, ?3, ?4)",
        params![block_id, content, tag_names, heading.unwrap_or_default()],
    )?;
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub id: String,
    pub heading: Option<String>,
    pub snippet: String,
}

pub fn search(
    conn: &Connection,
    query: &str,
    limit: i64,
    case_sensitive: bool,
) -> Result<Vec<SearchHit>> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let q = sanitize_fts_query(query);
    // SQLite FTS5 is always case-insensitive. For case-sensitive search
    // we still let FTS find candidate hits (cheap, indexed), then add a
    // case-sensitive `instr` post-filter that requires the literal
    // trimmed query be present in the block's content.
    let literal = query.trim();
    let mut stmt = if case_sensitive {
        conn.prepare(
            "SELECT b.id, b.heading, snippet(blocks_fts, 1, '<mark>', '</mark>', '…', 12) AS snip
             FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.id
             WHERE blocks_fts MATCH ?1 AND instr(b.content, ?3) > 0
             ORDER BY rank LIMIT ?2",
        )?
    } else {
        conn.prepare(
            "SELECT b.id, b.heading, snippet(blocks_fts, 1, '<mark>', '</mark>', '…', 12) AS snip
             FROM blocks_fts JOIN blocks b ON b.id = blocks_fts.id
             WHERE blocks_fts MATCH ?1 ORDER BY rank LIMIT ?2",
        )?
    };
    let rows: Vec<SearchHit> = if case_sensitive {
        stmt.query_map(params![q, limit, literal], |row| {
            Ok(SearchHit {
                id: row.get(0)?,
                heading: row.get(1)?,
                snippet: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map(params![q, limit], |row| {
            Ok(SearchHit {
                id: row.get(0)?,
                heading: row.get(1)?,
                snippet: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?
    };
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

/// Canonical post-save state for a single block. Returned to the
/// frontend so it can patch its in-memory store with the server-side
/// truth (which differs from the input in two ways: content has
/// hashtags stripped, and tags are the merged final set).
#[derive(Debug, Clone, Serialize)]
pub struct SavedBlock {
    pub id: String,
    pub content: String,
    pub content_hash: String,
    pub tags: Vec<String>,
    pub pinned: bool,
    pub updated_at: i64,
}

/// Save a snapshot of the document's blocks. The caller (the editor)
/// provides:
///   - `blocks` — every block currently in the document, in order
///   - `deleted_ids` — IDs that existed but no longer do (e.g. user
///     pressed Backspace to merge two blocks)
///
/// The server:
///   - For each input block: strips inline `#hashtag` tokens from
///     content, recomputes hash on the stripped content, merges the
///     extracted hashtags with any explicit `input.tags` to form the
///     final tag set, upserts missing rows into `tags`, rewrites
///     `block_tags` rows for this block, and refreshes `blocks_fts`.
///   - Writes a `block_versions` row only when `content_hash` actually
///     changed (so unchanged rows are cheap and don't bloat history).
///   - DELETEs any blocks listed in `deleted_ids` (their `block_tags`
///     rows go via FK cascade; FTS rows are removed explicitly).
///
/// Returns the canonical post-save state for every input block — the
/// frontend patches its store from this rather than guessing what the
/// server did.
pub fn save_snapshot(
    conn: &mut Connection,
    blocks: &[BlockInput],
    deleted_ids: &[String],
    source: &str,
) -> Result<Vec<SavedBlock>> {
    let now = Utc::now().timestamp_millis();
    let tx = conn.transaction()?;

    let mut saved: Vec<SavedBlock> = Vec::with_capacity(blocks.len());

    for b in blocks {
        let prior: Option<(String, i64, i64)> = tx
            .query_row(
                "SELECT content_hash, created_at, pinned FROM blocks WHERE id = ?1",
                params![b.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;

        // Strip hashtags from content first; everything downstream
        // (hash, FTS, version row) sees the canonical stripped form.
        let extracted = parser::extract_hashtags(&b.content);
        let stripped_content = parser::strip_inline_hashtags(&b.content);
        let new_hash = parser::hash(&stripped_content);

        let pinned_val: i64 = match (b.pinned, &prior) {
            (Some(p), _) => if p { 1 } else { 0 },
            (None, Some((_, _, prior_pinned))) => *prior_pinned,
            (None, None) => 0,
        };

        let (created_at, content_changed, parent_hash, prior_existed) = match &prior {
            Some((prior_hash, created, _)) => {
                let changed_now = *prior_hash != new_hash;
                (*created, changed_now, Some(prior_hash.clone()), true)
            }
            None => (now, true, None, false),
        };

        tx.execute(
            "INSERT INTO blocks(id, parent_id, position, heading, heading_level, content, content_hash, pinned, created_at, updated_at)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               parent_id=excluded.parent_id,
               position=excluded.position,
               heading=excluded.heading,
               heading_level=excluded.heading_level,
               content=excluded.content,
               content_hash=excluded.content_hash,
               pinned=excluded.pinned,
               -- updated_at bumps ONLY when the content actually changed.
               -- Position / parent_id / heading_level / pinned changes
               -- are structural and shouldn't lie about when the user
               -- last touched the block.
               updated_at=CASE WHEN blocks.content_hash=excluded.content_hash
                          THEN blocks.updated_at ELSE excluded.updated_at END",
            params![
                b.id,
                b.parent_id,
                b.position,
                b.heading,
                b.heading_level,
                stripped_content,
                new_hash,
                pinned_val,
                created_at,
                now,
            ],
        )?;

        // Final tag set: extracted-from-content ∪ explicit input tags
        // (when present). When `input.tags` is None and the block
        // existed before, the prior tag set is preserved — purely
        // structural saves (reorder, pin toggle) don't touch tags.
        let final_tag_names: Vec<String> = if b.tags.is_some() || !prior_existed {
            let mut set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
            for t in &extracted {
                set.insert(t.clone());
            }
            if let Some(explicit) = &b.tags {
                for t in explicit {
                    let cleaned = t.trim().trim_start_matches('#').to_lowercase();
                    if cleaned.is_empty() {
                        continue;
                    }
                    // Cheap shape check — same recognizer as the parser.
                    if cleaned
                        .chars()
                        .next()
                        .map(|c| c.is_ascii_alphabetic())
                        .unwrap_or(false)
                        && cleaned
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '/')
                    {
                        set.insert(cleaned);
                    }
                }
            }
            set.into_iter().collect()
        } else {
            // Preserve prior tag set; merge in any newly-typed inline
            // hashtags that the user added (extracted from content).
            let existing: std::collections::BTreeSet<String> =
                fetch_one_block_tags_in_tx(&tx, &b.id)?.into_iter().collect();
            let mut merged = existing;
            for t in &extracted {
                merged.insert(t.clone());
            }
            merged.into_iter().collect()
        };

        // Rewrite block_tags rows for this block. Two-step (delete
        // then insert) is simpler than a diff and the row count is
        // tiny (~handful of tags per block).
        tx.execute(
            "DELETE FROM block_tags WHERE block_id = ?1",
            params![b.id],
        )?;
        for name in &final_tag_names {
            let tag_id = upsert_tag(&tx, name, now)?;
            tx.execute(
                "INSERT OR IGNORE INTO block_tags(block_id, tag_id) VALUES(?1, ?2)",
                params![b.id, tag_id],
            )?;
        }

        // FTS sync: refresh on content change OR tag-set change. A
        // tag-only update (no content change) still needs FTS rewritten
        // so search-by-tag-name reflects the new set.
        refresh_fts_row(&tx, &b.id)?;

        if content_changed {
            tx.execute(
                "INSERT OR IGNORE INTO block_versions(block_id, content_hash, content, parent_hash, edited_at, source)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![b.id, new_hash, stripped_content, parent_hash, now, source],
            )?;

            // Trim version history for this block. Two caps:
            //   1. 30-day age cap for every block (always preserves at
            //      least one historical version so the user has SOME
            //      "undo" target even after a long gap).
            //   2. Large-block count cap: when the current content is
            //      over LARGE_BLOCK_BYTES, also keep only the most
            //      recent LARGE_BLOCK_VERSION_CAP versions — large
            //      blocks accumulate disk fastest, so they get the
            //      tighter limit.
            const THIRTY_DAYS_MS: i64 = 30 * 24 * 60 * 60 * 1000;
            const LARGE_BLOCK_BYTES: usize = 2048;
            const LARGE_BLOCK_VERSION_CAP: i64 = 30;

            tx.execute(
                "DELETE FROM block_versions
                 WHERE block_id = ?1
                   AND edited_at < ?2
                   AND id NOT IN (
                     SELECT id FROM block_versions
                     WHERE block_id = ?1
                     ORDER BY edited_at DESC
                     LIMIT 1
                   )",
                params![b.id, now - THIRTY_DAYS_MS],
            )?;

            if stripped_content.len() > LARGE_BLOCK_BYTES {
                tx.execute(
                    "DELETE FROM block_versions
                     WHERE block_id = ?1
                       AND id NOT IN (
                         SELECT id FROM block_versions
                         WHERE block_id = ?1
                         ORDER BY edited_at DESC
                         LIMIT ?2
                       )",
                    params![b.id, LARGE_BLOCK_VERSION_CAP],
                )?;
            }
        }

        let updated_at: i64 = tx.query_row(
            "SELECT updated_at FROM blocks WHERE id = ?1",
            params![b.id],
            |r| r.get(0),
        )?;

        saved.push(SavedBlock {
            id: b.id.clone(),
            content: stripped_content,
            content_hash: new_hash,
            tags: final_tag_names,
            pinned: pinned_val != 0,
            updated_at,
        });
    }

    for id in deleted_ids {
        // FK cascade clears block_tags rows.
        tx.execute("DELETE FROM blocks WHERE id = ?1", params![id])?;
        tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![id])?;
    }

    tx.commit()?;
    Ok(saved)
}

/// Read joined tag names for one block within an open transaction.
/// Mirrors `fetch_one_block_tags` but operates on a `Transaction` —
/// `save_snapshot` needs to read the prior set right after the upsert
/// but before any commit, so the inserted block sees its existing
/// tag rows.
fn fetch_one_block_tags_in_tx(
    tx: &rusqlite::Transaction,
    block_id: &str,
) -> Result<Vec<String>> {
    let mut stmt = tx.prepare(
        "SELECT t.name FROM block_tags bt
         JOIN tags t ON t.id = bt.tag_id
         WHERE bt.block_id = ?1
         ORDER BY t.name",
    )?;
    let rows = stmt
        .query_map(params![block_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Trim `block_versions` to bound disk growth. Two passes:
///   - Drop any version older than 30 days, while always preserving
///     the most recent version per block (so even after a long gap
///     the user has SOMETHING to restore to).
///   - For blocks whose current content exceeds ~2KB, keep at most
///     the 30 most recent versions. Large blocks accumulate history
///     bytes fastest, so they get the tighter cap.
///
/// Returns the number of rows deleted (for diagnostic logging).
/// Called on workspace open AND inline in `save_snapshot` per block,
/// so growth never re-emerges between restarts.
pub fn prune_block_versions(conn: &Connection) -> Result<usize> {
    let now = Utc::now().timestamp_millis();
    const THIRTY_DAYS_MS: i64 = 30 * 24 * 60 * 60 * 1000;
    const LARGE_BLOCK_BYTES: i64 = 2048;
    const LARGE_BLOCK_VERSION_CAP: i64 = 30;

    let aged = conn.execute(
        "DELETE FROM block_versions
         WHERE edited_at < ?1
           AND id NOT IN (
             SELECT MAX(id) FROM block_versions GROUP BY block_id
           )",
        params![now - THIRTY_DAYS_MS],
    )?;

    // For each block whose CURRENT content is large, drop versions
    // beyond the cap. Counts newer-sibling versions per row — `n` is
    // the position from latest (0-indexed), so `n >= cap` means this
    // version is past the cap. Correlated subquery is fine for a
    // one-shot startup pass.
    let sized = conn.execute(
        "DELETE FROM block_versions
         WHERE id IN (
           SELECT bv.id FROM block_versions bv
           JOIN blocks b ON b.id = bv.block_id
           WHERE length(b.content) > ?1
             AND (
               SELECT COUNT(*) FROM block_versions bv2
               WHERE bv2.block_id = bv.block_id
                 AND bv2.edited_at > bv.edited_at
             ) >= ?2
         )",
        params![LARGE_BLOCK_BYTES, LARGE_BLOCK_VERSION_CAP],
    )?;

    Ok(aged + sized)
}

/// v4 → v5 migration. Normalizes tag storage and strips inline
/// `#hashtag` text from block content in one pass:
///   1. Create the new `tags` + `block_tags` tables and their indexes.
///   2. Copy any existing `tag_metadata` rows into `tags`.
///   3. For each block: parse its JSON tag list (legacy column),
///      strip hashtags from content, recompute hash. Insert any
///      missing tag names into `tags`, then one `block_tags` row per
///      (block, tag). Update the block row with stripped content +
///      new hash. Refresh `blocks_fts`. Record a `block_versions` row
///      for the strip so per-block rollback is possible.
///   4. Add the `pinned` column to `blocks` (idempotent).
///   5. Drop the legacy `tags` + `manual_tags` columns from `blocks`
///      via the SQLite table-rebuild dance.
///   6. Drop the now-redundant `tag_metadata` table.
///
/// All in one transaction. The caller should have already taken a
/// backup of `blocks.db` before invoking this — recovery path for
/// users upgrading from 0.2.x.
pub fn heal_strip_inline_tags(conn: &mut Connection) -> Result<()> {
    let now = Utc::now().timestamp_millis();
    let tx = conn.transaction()?;

    // 1. Create new tables (idempotent — schema may already exist for
    //    fresh installs that bypassed the migration).
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS tags (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           name TEXT NOT NULL UNIQUE,
           description TEXT NOT NULL DEFAULT '',
           sort_order INTEGER,
           folder TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS block_tags (
           block_id TEXT NOT NULL,
           tag_id INTEGER NOT NULL,
           PRIMARY KEY (block_id, tag_id),
           FOREIGN KEY (block_id) REFERENCES blocks(id) ON DELETE CASCADE,
           FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS idx_block_tags_tag ON block_tags(tag_id);",
    )?;

    // 2. Copy legacy tag_metadata rows. If the table doesn't exist
    //    (fresh install or older pre-v3 workspace), skip silently.
    let has_tag_metadata: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tag_metadata'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_tag_metadata > 0 {
        tx.execute(
            "INSERT OR IGNORE INTO tags(name, description, sort_order, folder, created_at, updated_at)
             SELECT name, COALESCE(description, ''), sort_order, folder, COALESCE(updated_at, ?1), COALESCE(updated_at, ?1)
             FROM tag_metadata",
            params![now],
        )?;
    }

    // 3. Walk blocks. Use the legacy `tags` JSON column if it still
    //    exists; otherwise fall back to fresh extraction.
    let has_legacy_tags_col: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('blocks') WHERE name='tags'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let block_rows: Vec<(String, String, Option<String>, Option<String>)> = {
        let sql = if has_legacy_tags_col > 0 {
            "SELECT id, content, heading, tags FROM blocks"
        } else {
            "SELECT id, content, heading, NULL FROM blocks"
        };
        let mut stmt = tx.prepare(sql)?;
        let rows: rusqlite::Result<Vec<(String, String, Option<String>, Option<String>)>> = stmt
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, Option<String>>(3)?))
            })?
            .collect();
        rows?
    };

    for (id, content, heading, legacy_tags_json) in block_rows {
        // Parse legacy tag list (if any) AND extract from current
        // content — content may have been written by an external
        // agent that skipped tag extraction.
        let extracted = parser::extract_hashtags(&content);
        let legacy_tags: Vec<String> = legacy_tags_json
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
            .unwrap_or_default();
        let mut union_set: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();
        for t in extracted.iter().chain(legacy_tags.iter()) {
            let cleaned = t.trim().trim_start_matches('#').to_lowercase();
            if !cleaned.is_empty() {
                union_set.insert(cleaned);
            }
        }

        let stripped = parser::strip_inline_hashtags(&content);
        let new_hash = parser::hash(&stripped);
        let content_changed = stripped != content;

        // Update the block row only when content actually changed.
        // (No-op for blocks that never carried inline tags.)
        if content_changed {
            tx.execute(
                "UPDATE blocks SET content = ?1, content_hash = ?2, updated_at = updated_at WHERE id = ?3",
                params![stripped, new_hash, id],
            )?;
            tx.execute(
                "INSERT OR IGNORE INTO block_versions(block_id, content_hash, content, parent_hash, edited_at, source)
                 VALUES(?1, ?2, ?3, NULL, ?4, 'migration-strip-tags')",
                params![id, new_hash, stripped, now],
            )?;
        }

        // Rewrite block_tags rows from the union set. Upserts missing
        // tag names along the way.
        tx.execute(
            "DELETE FROM block_tags WHERE block_id = ?1",
            params![id],
        )?;
        for name in &union_set {
            let tag_id = upsert_tag(&tx, name, now)?;
            tx.execute(
                "INSERT OR IGNORE INTO block_tags(block_id, tag_id) VALUES(?1, ?2)",
                params![id, tag_id],
            )?;
        }

        // Refresh FTS row with stripped content + joined tag names.
        let joined = union_set.iter().cloned().collect::<Vec<_>>().join(" ");
        tx.execute("DELETE FROM blocks_fts WHERE id = ?1", params![id])?;
        tx.execute(
            "INSERT INTO blocks_fts(id, content, tags, heading) VALUES(?1, ?2, ?3, ?4)",
            params![id, stripped, joined, heading.unwrap_or_default()],
        )?;
    }

    // 4. Add `pinned` column to `blocks`. SQLite ALTER TABLE will fail
    //    on duplicate column; catch and ignore that case.
    match tx.execute("ALTER TABLE blocks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0", []) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.contains("duplicate column name") => {}
        Err(e) => return Err(e.into()),
    }

    // 5. Drop legacy columns (`tags`, `manual_tags`) via table rebuild.
    //    Only do this if at least one of them still exists.
    let has_legacy_cols: i64 = tx
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('blocks') WHERE name IN ('tags', 'manual_tags')",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_legacy_cols > 0 {
        tx.execute_batch(
            "CREATE TABLE blocks_new (
               id TEXT PRIMARY KEY,
               parent_id TEXT,
               position INTEGER NOT NULL,
               heading TEXT,
               heading_level INTEGER,
               content TEXT NOT NULL,
               content_hash TEXT NOT NULL,
               pinned INTEGER NOT NULL DEFAULT 0,
               created_at INTEGER NOT NULL,
               updated_at INTEGER NOT NULL
             );
             INSERT INTO blocks_new(id, parent_id, position, heading, heading_level, content, content_hash, pinned, created_at, updated_at)
               SELECT id, parent_id, position, heading, heading_level, content, content_hash, COALESCE(pinned, 0), created_at, updated_at FROM blocks;
             DROP TABLE blocks;
             ALTER TABLE blocks_new RENAME TO blocks;
             CREATE INDEX IF NOT EXISTS idx_blocks_position ON blocks(position);
             CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id);",
        )?;
    }

    // 6. Drop tag_metadata — its data lives in `tags` now.
    tx.execute("DROP TABLE IF EXISTS tag_metadata", [])?;

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

/// Build a `StoredBlock` from a row of:
/// `id, parent_id, position, heading, heading_level, content, content_hash, pinned, created_at, updated_at`
/// using the pre-fetched `tag_map` so each row doesn't trigger its own
/// join. The block's tags are looked up by id in the map; an absent
/// entry just means "no tags."
fn row_to_block(
    row: &rusqlite::Row,
    tag_map: &std::collections::HashMap<String, Vec<String>>,
) -> rusqlite::Result<StoredBlock> {
    let heading_level: Option<i64> = row.get(4)?;
    let pinned: i64 = row.get(7)?;
    let id: String = row.get(0)?;
    let tags = tag_map.get(&id).cloned().unwrap_or_default();
    Ok(StoredBlock {
        id,
        parent_id: row.get(1)?,
        position: row.get(2)?,
        heading: row.get(3)?,
        heading_level: heading_level.map(|l| l as u8),
        content: row.get(5)?,
        content_hash: row.get(6)?,
        tags,
        pinned: pinned != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
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

use crate::config;
use crate::db::{self, BackupInfo, BlockInput, BlockVersion, SearchHit, StoredBlock, TagCount};
use crate::error::{AppError, Result};
use crate::state::AppState;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

#[derive(Debug, Serialize)]
pub struct LoadResult {
    pub blocks: Vec<StoredBlock>,
    pub path: String,
}

/// Open the app on launch: read config to find the active workspace, fall
/// back to the default location under app-data-dir if none / missing.
#[tauri::command]
pub fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<LoadResult> {
    let cfg = config::load(&app).unwrap_or_default();
    let path = match cfg.workspace_path.as_deref() {
        Some(p) if config::is_usable_workspace(Path::new(p)) => PathBuf::from(p),
        _ => config::default_workspace(&app)?,
    };
    state.open(path.clone())?;
    let path_string = path.to_string_lossy().to_string();
    // Persist whatever we ended up with (e.g. on first launch where the
    // config didn't yet name a workspace).
    let _ = config::save(
        &app,
        &config::Config {
            workspace_path: Some(path_string.clone()),
        },
    );
    let blocks = db_list_blocks(&state)?;
    Ok(LoadResult {
        blocks,
        path: path_string,
    })
}

/// Switch to a different workspace folder. Persists the new path in config.
#[tauri::command]
pub fn switch_workspace(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LoadResult> {
    let buf = PathBuf::from(&path);
    if !config::is_usable_workspace(&buf) {
        return Err(AppError::Other(format!("not a directory: {path}")));
    }
    state.open(buf.clone())?;
    config::save(
        &app,
        &config::Config {
            workspace_path: Some(path.clone()),
        },
    )?;
    let blocks = db_list_blocks(&state)?;
    Ok(LoadResult { blocks, path })
}

/// Move the current workspace's data (`.notesapp/` and any sibling Mochi
/// artifacts like the legacy markdown export) into `target`, then reopen on
/// the new location and persist that path. The target must be an existing,
/// empty-of-Mochi-data directory — we refuse to overwrite a `.notesapp/` in
/// the destination.
#[tauri::command]
pub fn move_workspace(
    target: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LoadResult> {
    let target_buf = PathBuf::from(&target);
    if !target_buf.is_dir() {
        return Err(AppError::Other(format!("not a directory: {target}")));
    }
    if target_buf.join(".notesapp").exists() {
        return Err(AppError::Other(
            "destination already contains a Mochi workspace (.notesapp/ exists)".to_string(),
        ));
    }
    let current = state
        .root()
        .ok_or(AppError::NoWorkspace)?;
    if current == target_buf {
        return Err(AppError::Other("source and destination are the same".to_string()));
    }

    // Drop the live DB so we can move the file.
    state.close();

    let src_notesapp = current.join(".notesapp");
    let dst_notesapp = target_buf.join(".notesapp");
    if src_notesapp.is_dir() {
        std::fs::rename(&src_notesapp, &dst_notesapp)?;
    }
    // Best-effort move of the legacy markdown if it exists.
    let legacy_src = current.join("canvas.md.legacy-pre-sqlite");
    if legacy_src.is_file() {
        let _ = std::fs::rename(&legacy_src, target_buf.join("canvas.md.legacy-pre-sqlite"));
    }

    state.open(target_buf.clone())?;
    config::save(
        &app,
        &config::Config {
            workspace_path: Some(target.clone()),
        },
    )?;
    let blocks = db_list_blocks(&state)?;
    Ok(LoadResult { blocks, path: target })
}

fn db_list_blocks(state: &State<'_, AppState>) -> Result<Vec<StoredBlock>> {
    state.with(|ws| db::list_blocks(&ws.db))
}

#[tauri::command]
pub fn workspace_path(state: State<'_, AppState>) -> Option<String> {
    state.root().map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_blocks(state: State<'_, AppState>) -> Result<Vec<StoredBlock>> {
    state.with(|ws| db::list_blocks(&ws.db))
}

#[tauri::command]
pub fn list_blocks_by_tag(tag: String, state: State<'_, AppState>) -> Result<Vec<StoredBlock>> {
    state.with(|ws| db::list_blocks_by_tag(&ws.db, &tag))
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<TagCount>> {
    state.with(|ws| db::list_tags(&ws.db))
}

#[tauri::command]
pub fn search(
    query: String,
    limit: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<SearchHit>> {
    state.with(|ws| db::search(&ws.db, &query, limit.unwrap_or(50)))
}

#[derive(Debug, Deserialize)]
pub struct SaveBlocksArgs {
    pub blocks: Vec<BlockInput>,
    #[serde(default)]
    pub deleted_ids: Vec<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct SaveResult {
    pub changed_ids: Vec<String>,
    pub mtime: i64,
}

/// Save a (typically diff-only) batch of blocks plus any deletions. Returns
/// the IDs whose content actually changed (per the DB's hash check) plus the
/// new `blocks.db` mtime — the frontend already has the latest content
/// locally, so there's no point re-fetching the whole table over IPC after
/// every keystroke.
#[tauri::command]
pub fn save_blocks(args: SaveBlocksArgs, state: State<'_, AppState>) -> Result<SaveResult> {
    state.with(|ws| {
        let source = args.source.unwrap_or_else(|| "canvas".to_string());
        let changed = db::save_snapshot(&mut ws.db, &args.blocks, &args.deleted_ids, &source)?;
        let mtime = blocks_db_mtime(&ws.root);
        Ok(SaveResult {
            changed_ids: changed,
            mtime,
        })
    })
}

#[tauri::command]
pub fn list_versions(id: String, state: State<'_, AppState>) -> Result<Vec<BlockVersion>> {
    state.with(|ws| db::list_versions(&ws.db, &id))
}

/// Write a UTF-8 text file at `path`. Used for ad-hoc exports (e.g. dumping
/// selected blocks to a markdown file picked via the save dialog).
#[tauri::command]
pub fn write_text_file(path: String, content: String) -> Result<()> {
    std::fs::write(PathBuf::from(&path), content)?;
    Ok(())
}

#[tauri::command]
pub fn get_setting(key: String, state: State<'_, AppState>) -> Result<Option<String>> {
    state.with(|ws| db::get_setting(&ws.db, &key))
}

#[tauri::command]
pub fn set_setting(key: String, value: String, state: State<'_, AppState>) -> Result<()> {
    state.with(|ws| db::set_setting(&ws.db, &key, &value))
}

// =========================================================================
// Backups
// =========================================================================

#[tauri::command]
pub fn create_backup(state: State<'_, AppState>) -> Result<BackupInfo> {
    state.with(|ws| {
        let info = db::backup(&ws.db, &ws.root)?;
        let _ = db::prune_backups(&ws.root, 60);
        Ok(info)
    })
}

#[tauri::command]
pub fn list_backups(state: State<'_, AppState>) -> Result<Vec<BackupInfo>> {
    state.with(|ws| db::list_backups(&ws.root))
}

#[tauri::command]
pub fn restore_backup(name: String, state: State<'_, AppState>) -> Result<Vec<StoredBlock>> {
    let root = state.root().ok_or(crate::error::AppError::NoWorkspace)?;
    db::restore_backup(&root, &name)?;
    state.reopen_db()?;
    state.with(|ws| db::list_blocks(&ws.db))
}

#[derive(Debug, Serialize)]
pub struct BackupHeading {
    pub id: String,
    pub heading: String,
    pub level: u8,
    pub position: i64,
}

#[derive(Debug, Serialize)]
pub struct BackupPreview {
    pub block_count: i64,
    pub total_chars: i64,
    pub latest_updated_at: i64,
    pub oldest_created_at: i64,
    pub headings: Vec<BackupHeading>,
}

/// Open the named backup file as a read-only SQLite connection and summarize
/// its contents. No mutation, no editor mount — just enough to let the user
/// decide whether to restore.
#[tauri::command]
pub fn preview_backup(name: String, state: State<'_, AppState>) -> Result<BackupPreview> {
    let root = state.root().ok_or(AppError::NoWorkspace)?;
    let path = root.join(".notesapp").join("backups").join(&name);
    if !path.is_file() {
        return Err(AppError::Other(format!("backup not found: {name}")));
    }
    let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let block_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
    let total_chars: i64 = conn
        .query_row("SELECT COALESCE(SUM(LENGTH(content)), 0) FROM blocks", [], |r| {
            r.get(0)
        })?;
    let latest_updated_at: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(updated_at), 0) FROM blocks",
            [],
            |r| r.get(0),
        )?;
    let oldest_created_at: i64 = conn
        .query_row(
            "SELECT COALESCE(MIN(created_at), 0) FROM blocks",
            [],
            |r| r.get(0),
        )?;

    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(heading, ''), COALESCE(heading_level, 0), position
         FROM blocks WHERE heading_level IS NOT NULL ORDER BY position",
    )?;
    let headings = stmt
        .query_map([], |row| {
            let level: i64 = row.get(2)?;
            Ok(BackupHeading {
                id: row.get(0)?,
                heading: row.get(1)?,
                level: level as u8,
                position: row.get(3)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    Ok(BackupPreview {
        block_count,
        total_chars,
        latest_updated_at,
        oldest_created_at,
        headings,
    })
}

#[tauri::command]
pub fn should_backup(state: State<'_, AppState>) -> Result<bool> {
    state.with(|ws| db::should_backup(&ws.root))
}

// =========================================================================
// Export
// =========================================================================

/// Synthesize a `canvas.md` from the current block table and write it to the
/// workspace root. Returns the absolute path written so the UI can show it.
#[tauri::command]
pub fn export_canvas(state: State<'_, AppState>) -> Result<String> {
    state.with(|ws| {
        let blocks = db::list_blocks(&ws.db)?;
        let mut out = String::new();
        for (i, b) in blocks.iter().enumerate() {
            if i > 0 {
                out.push_str("\n\n");
            }
            out.push_str(&format!("<!-- block:{} -->\n", b.id));
            out.push_str(&b.content);
        }
        out.push('\n');
        let path = ws.root.join("canvas.md");
        std::fs::write(&path, &out)?;
        Ok(path.to_string_lossy().to_string())
    })
}

// =========================================================================
// Agent change detection
// =========================================================================

/// mtime (in milliseconds since epoch) of `blocks.db`. The frontend polls this
/// to detect external writes (e.g. an agent UPDATEing rows directly).
#[tauri::command]
pub fn blocks_mtime(state: State<'_, AppState>) -> Result<i64> {
    state.with(|ws| Ok(blocks_db_mtime(&ws.root)))
}

fn blocks_db_mtime(workspace: &std::path::Path) -> i64 {
    let p = workspace.join(".notesapp").join("blocks.db");
    let meta = match std::fs::metadata(&p) {
        Ok(m) => m,
        Err(_) => return 0,
    };
    let m = match meta.modified() {
        Ok(t) => t,
        Err(_) => return 0,
    };
    match m.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

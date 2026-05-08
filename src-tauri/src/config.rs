//! Persistent app-level config. Stored as `config.json` inside the Tauri
//! app-data dir. Today it just remembers which workspace folder is active.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Config {
    /// Last opened workspace folder. None = boot to default.
    pub workspace_path: Option<String>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn config_path(app: &AppHandle) -> Result<PathBuf> {
    Ok(config_dir(app)?.join("config.json"))
}

pub fn load(app: &AppHandle) -> Result<Config> {
    let path = config_path(app)?;
    if !path.is_file() {
        return Ok(Config::default());
    }
    let text = std::fs::read_to_string(&path)?;
    let cfg: Config = serde_json::from_str(&text).unwrap_or_default();
    Ok(cfg)
}

pub fn save(app: &AppHandle, cfg: &Config) -> Result<()> {
    let path = config_path(app)?;
    let text = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&path, text)?;
    Ok(())
}

/// The default workspace location for first-launch users:
/// `<app_data_dir>/default`. The directory is created on demand.
pub fn default_workspace(app: &AppHandle) -> Result<PathBuf> {
    let dir = config_dir(app)?.join("default");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// True if a folder looks usable as a Mochi workspace — i.e. it's an existing
/// directory we can write to. (Existing `.notesapp/blocks.db` is NOT required;
/// switching to an empty folder seeds it.)
pub fn is_usable_workspace(p: &Path) -> bool {
    p.is_dir()
}

//! Tauri commands for pairing + driving sync from the UI.

use crate::error::Result;
use crate::state::AppState;
use crate::sync::client::{self, SyncStats};
use crate::sync::oplog;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
pub struct PairInfo {
    /// Payload the phone scans — matches the mobile QR format
    /// `{ url, workspace_id, token }`.
    pub url: String,
    pub workspace_id: String,
    pub token: String,
}

#[derive(Serialize)]
pub struct SyncStatus {
    pub paired: bool,
    pub relay_url: Option<String>,
    pub workspace_id: Option<String>,
    pub token: Option<String>,
    pub device_id: Option<String>,
}

/// Pair this (owner) device with the relay, minting a new workspace, and store
/// the credentials. Returns the QR payload for the phone to scan.
#[tauri::command]
pub async fn sync_pair(relay_url: String, state: State<'_, AppState>) -> Result<PairInfo> {
    let device = state.with(|ws| oplog::device_id(&ws.db))?;
    let http = reqwest::Client::new();
    let (workspace_id, token) = client::pair(&http, &relay_url, &device, None).await?;
    state.with(|ws| {
        crate::db::set_setting(&ws.db, "sync.relay_url", &relay_url)?;
        crate::db::set_setting(&ws.db, "sync.workspace_id", &workspace_id)?;
        crate::db::set_setting(&ws.db, "sync.token", &token)?;
        Ok(())
    })?;
    Ok(PairInfo { url: relay_url, workspace_id, token })
}

#[tauri::command]
pub fn sync_status(state: State<'_, AppState>) -> Result<SyncStatus> {
    state.with(|ws| {
        let relay_url = crate::db::get_setting(&ws.db, "sync.relay_url")?;
        let workspace_id = crate::db::get_setting(&ws.db, "sync.workspace_id")?;
        let token = crate::db::get_setting(&ws.db, "sync.token")?;
        let device_id = oplog::get_meta(&ws.db, "device_id")?;
        Ok(SyncStatus {
            paired: relay_url.as_deref().map(|s| !s.is_empty()).unwrap_or(false),
            relay_url,
            workspace_id,
            token,
            device_id,
        })
    })
}

#[tauri::command]
pub fn sync_unpair(state: State<'_, AppState>) -> Result<()> {
    state.with(|ws| {
        ws.db.execute("DELETE FROM settings WHERE key LIKE 'sync.%'", [])?;
        Ok(())
    })
}

/// Run one sync cycle on demand (the background task also runs it periodically).
#[tauri::command]
pub async fn sync_tick(state: State<'_, AppState>) -> Result<SyncStats> {
    let http = reqwest::Client::new();
    client::sync_once(state.inner(), &http).await
}

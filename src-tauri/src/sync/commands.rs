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

/// Reject non-HTTPS relay URLs except loopback, so the bearer token is never
/// sent in cleartext to a remote host.
fn require_secure_relay(relay_url: &str) -> Result<()> {
    let lower = relay_url.trim().to_ascii_lowercase();
    let is_https = lower.starts_with("https://");
    let is_loopback = lower.starts_with("http://localhost")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("http://[::1]");
    if is_https || is_loopback {
        Ok(())
    } else {
        Err(crate::error::AppError::Other(
            "relay URL must use https:// (only localhost may use http://)".into(),
        ))
    }
}

/// Pair this (owner) device with the relay, minting a new workspace, and store
/// the credentials. Returns the QR payload for the phone to scan.
#[tauri::command]
pub async fn sync_pair(
    relay_url: String,
    pairing_secret: Option<String>,
    state: State<'_, AppState>,
) -> Result<PairInfo> {
    require_secure_relay(&relay_url)?;
    let device = state.with(|ws| oplog::device_id(&ws.db))?;
    let http = reqwest::Client::new();
    let (workspace_id, token) =
        client::pair(&http, &relay_url, &device, None, pairing_secret.as_deref()).await?;
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

// ---- Audio clips ---------------------------------------------------------
// Voice-note audio isn't carried by the oplog — only the transcript block syncs.
// The relay stores the m4a out-of-band, keyed by clip id (== block id for notes).
// The desktop discovers which blocks have audio via the manifest and streams the
// bytes on demand for playback. No schema/wire change needed.

#[derive(serde::Deserialize)]
struct ManifestClip {
    clip_id: String,
    kind: String,
}

#[derive(serde::Deserialize)]
struct ManifestResp {
    clips: Vec<ManifestClip>,
    next_cursor: i64,
    has_more: bool,
}

/// Block ids that have a synced voice-note audio clip on the relay.
#[tauri::command]
pub async fn audio_note_ids(state: State<'_, AppState>) -> Result<Vec<String>> {
    let Some(cfg) = client::load_config(state.inner())? else {
        return Ok(vec![]);
    };
    let http = reqwest::Client::new();
    let mut ids = Vec::new();
    let mut since: i64 = 0;
    loop {
        let resp: ManifestResp = http
            .get(format!("{}/audio/manifest?since={}", cfg.relay_url, since))
            .bearer_auth(&cfg.token)
            .send()
            .await
            .map_err(|e| crate::error::AppError::Other(format!("audio manifest: {e}")))?
            .json()
            .await
            .map_err(|e| crate::error::AppError::Other(format!("audio manifest decode: {e}")))?;
        for c in &resp.clips {
            if c.kind == "note" {
                ids.push(c.clip_id.clone());
            }
        }
        if !resp.has_more || resp.next_cursor == since {
            break;
        }
        since = resp.next_cursor;
    }
    Ok(ids)
}

/// Stream one clip's raw m4a bytes from the relay (the webview wraps them in a
/// Blob to play). Clips are small; returning bytes over IPC keeps the token in
/// Rust rather than handing it to the frontend.
#[tauri::command]
pub async fn audio_fetch(clip_id: String, state: State<'_, AppState>) -> Result<Vec<u8>> {
    let Some(cfg) = client::load_config(state.inner())? else {
        return Err(crate::error::AppError::Other("not paired".into()));
    };
    let http = reqwest::Client::new();
    let res = http
        .get(format!("{}/audio/{}", cfg.relay_url, clip_id))
        .bearer_auth(&cfg.token)
        .send()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("audio fetch: {e}")))?;
    if !res.status().is_success() {
        return Err(crate::error::AppError::Other(format!(
            "audio fetch failed: {}",
            res.status()
        )));
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| crate::error::AppError::Other(format!("audio body: {e}")))?;
    Ok(bytes.to_vec())
}

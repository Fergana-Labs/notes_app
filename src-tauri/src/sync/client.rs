//! The sync cycle: capture local changes, push pending ops, pull + apply remote
//! ops. DB work happens in short locked sections (`state.with`); network I/O
//! (reqwest) happens between them, so the connection is never held across an
//! await. Mirrors the loop in app/src/sync/client.ts.

use crate::error::{AppError, Result};
use crate::state::AppState;
use crate::sync::wire::Op;
use crate::sync::{apply, oplog, reconcile};
use serde::Deserialize;

const PEER: &str = "relay";
const PUSH_LIMIT: i64 = 500;
const PULL_LIMIT: i64 = 500;

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct SyncStats {
    pub pushed: usize,
    pub pulled: usize,
    pub applied: usize,
}

#[derive(Clone)]
pub struct SyncConfig {
    pub relay_url: String,
    pub workspace_id: String,
    pub token: String,
}

fn net_err(e: reqwest::Error) -> AppError {
    AppError::Other(format!("sync network error: {e}"))
}

/// Read the paired-workspace config from settings, if paired.
pub fn load_config(state: &AppState) -> Result<Option<SyncConfig>> {
    state.with(|ws| {
        let relay_url = crate::db::get_setting(&ws.db, "sync.relay_url")?;
        let workspace_id = crate::db::get_setting(&ws.db, "sync.workspace_id")?;
        let token = crate::db::get_setting(&ws.db, "sync.token")?;
        Ok(match (relay_url, workspace_id, token) {
            (Some(relay_url), Some(workspace_id), Some(token)) if !relay_url.is_empty() => {
                Some(SyncConfig { relay_url, workspace_id, token })
            }
            _ => None,
        })
    })
}

/// POST /pair — mint (or join) a workspace and return its token. The desktop is
/// the workspace owner: with no workspace_id it mints a new one.
pub async fn pair(
    http: &reqwest::Client,
    relay_url: &str,
    device_id: &str,
    workspace_id: Option<&str>,
    pairing_secret: Option<&str>,
) -> Result<(String, String)> {
    let mut req = http
        .post(format!("{relay_url}/pair"))
        .json(&serde_json::json!({ "device_id": device_id, "workspace_id": workspace_id }));
    // The relay requires this secret so strangers can't mint workspaces.
    if let Some(secret) = pairing_secret.filter(|s| !s.is_empty()) {
        req = req.header("x-pairing-secret", secret);
    }
    let res = req.send().await.map_err(net_err)?;
    if !res.status().is_success() {
        return Err(AppError::Other(format!("pair failed: {}", res.status())));
    }
    #[derive(Deserialize)]
    struct PairResp {
        token: String,
        workspace_id: String,
    }
    let body: PairResp = res.json().await.map_err(net_err)?;
    Ok((body.workspace_id, body.token))
}

async fn push(http: &reqwest::Client, cfg: &SyncConfig, device: &str, ops: &[Op]) -> Result<()> {
    let res = http
        .post(format!("{}/sync/push", cfg.relay_url))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({
            "workspace_id": cfg.workspace_id, "device_id": device, "ops": ops
        }))
        .send()
        .await
        .map_err(net_err)?;
    if !res.status().is_success() {
        return Err(AppError::Other(format!("push failed: {}", res.status())));
    }
    Ok(())
}

#[derive(Deserialize)]
struct PullResp {
    ops: Vec<Op>,
    next_cursor: String,
    has_more: bool,
}

async fn pull(
    http: &reqwest::Client,
    cfg: &SyncConfig,
    device: &str,
    cursor: &str,
) -> Result<PullResp> {
    let res = http
        .post(format!("{}/sync/pull", cfg.relay_url))
        .bearer_auth(&cfg.token)
        .json(&serde_json::json!({
            "workspace_id": cfg.workspace_id, "device_id": device, "cursor": cursor, "limit": PULL_LIMIT
        }))
        .send()
        .await
        .map_err(net_err)?;
    if !res.status().is_success() {
        return Err(AppError::Other(format!("pull failed: {}", res.status())));
    }
    res.json::<PullResp>().await.map_err(net_err)
}

/// Run one full capture → push → pull cycle. No-op (Ok default) when unpaired.
pub async fn sync_once(state: &AppState, http: &reqwest::Client) -> Result<SyncStats> {
    let Some(cfg) = load_config(state)? else {
        return Ok(SyncStats::default());
    };
    let device = state.with(|ws| oplog::device_id(&ws.db))?;
    let mut stats = SyncStats::default();

    // Capture local + agent-direct changes into the oplog.
    state.with(|ws| reconcile::capture(&mut ws.db, &device).map(|_| ()))?;

    // Push pending ops.
    loop {
        let (ops, max_seq) = state.with(|ws| {
            let cursor = oplog::push_cursor(&ws.db, PEER)?;
            oplog::pending_ops(&ws.db, &device, cursor, PUSH_LIMIT)
        })?;
        if ops.is_empty() {
            break;
        }
        let n = ops.len();
        push(http, &cfg, &device, &ops).await?;
        state.with(|ws| oplog::set_push_cursor(&ws.db, PEER, max_seq))?;
        stats.pushed += n;
        if (n as i64) < PUSH_LIMIT {
            break;
        }
    }

    // Pull + apply remote ops.
    loop {
        let cursor = state.with(|ws| oplog::pull_cursor(&ws.db, PEER))?;
        let resp = pull(http, &cfg, &device, &cursor).await?;
        let applied = state.with(|ws| {
            let mut n = 0;
            for op in &resp.ops {
                if apply::apply_remote_op(&mut ws.db, op)? {
                    n += 1;
                }
            }
            oplog::set_pull_cursor(&ws.db, PEER, &resp.next_cursor)?;
            Ok(n)
        })?;
        stats.pulled += resp.ops.len();
        stats.applied += applied;
        if !resp.has_more || resp.next_cursor == cursor {
            break;
        }
    }

    Ok(stats)
}

//! Sync wire types — mirror app/src/sync/types.ts and the relay. Entities are
//! keyed by their natural, device-stable key (block id, tag NAME, daily date).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Op {
    pub op_id: String,
    pub entity: String,     // "block" | "tag" | "daily_note"
    pub entity_key: String,
    pub op: String,         // "upsert" | "delete"
    pub payload: serde_json::Value,
    pub hlc_wall: i64,
    pub hlc_counter: i64,
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockPayload {
    pub id: String,
    pub parent_id: Option<String>,
    pub position: i64,
    pub heading: Option<String>,
    pub heading_level: Option<u8>,
    pub content: String, // hashtag-stripped (canonical)
    pub content_hash: String,
    pub title: Option<String>,
    pub tags: Vec<String>,
    pub pinned_scopes: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TagPayload {
    pub name: String,
    pub description: String,
    pub sort_order: Option<i64>,
    pub folder: Option<String>,
    pub priority: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyNotePayload {
    pub date: String,
    pub content: String,
    pub updated_at: i64,
}

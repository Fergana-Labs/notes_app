use crate::db::{self, BlockInput};
use crate::error::{AppError, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use ulid::Ulid;

const INTRO_BLOCKS: &[(Option<u8>, &str)] = &[
    (Some(1), "# Welcome to Mochi"),
    (
        None,
        "A local-first notebook. Your notes live in a SQLite database — Mochi is the editor, agents and scripts can read or write the DB directly, and you can export to markdown anytime.",
    ),
    (Some(2), "## Blocks"),
    (
        None,
        "Each row is one **block**. A block can hold a paragraph, a heading, a list, code — or several mixed together. Blocks are how Mochi gives you per-section history, tags, and rearrangement.",
    ),
    (
        None,
        "- **Enter** — new paragraph inside the same block.\n- **⌘ Enter** — split into a new block at the cursor.\n- **⌘⇧ Enter** — add an empty block below.\n- **Shift + Enter** — soft line break.\n- **Backspace** at the start of a block — merge with the block above.",
    ),
    (
        None,
        "Hover any block to see its left gutter — a **+** to add a block below and a **⋮** grip. Drag the grip to move the block; click it (or right-click anywhere on the block) for a menu with Turn into / Duplicate / Copy / Split into blocks / History / Delete.",
    ),
    (Some(2), "## Slash menu"),
    (
        None,
        "Type `/` anywhere to insert or transform. Try `/h2`, `/quote`, `/code`, `/todo`, `/divider`. Filter by typing a few letters.",
    ),
    (Some(2), "## Bubble menu"),
    (
        None,
        "Select any text and a small toolbar appears. **Bold** (`⌘B`), *italic* (`⌘I`), <u>underline</u> (`⌘U`), ~~strike~~, `code` (`⌘E`), link (`⌘K`). The \"Turn into\" dropdown converts the whole block.",
    ),
    (Some(2), "## Hashtags"),
    (
        None,
        "Type `#` to tag a block. The space distinguishes the two: `# heading` is a heading, `#tag` is a tag. Try `#welcome` or `#how-to`. A picker shows existing tags as you type; press Enter to commit.",
    ),
    (
        None,
        "Tags show up in the sidebar — clicking one opens an aggregated page where you can reorder and combine every block with that tag.",
    ),
    (Some(2), "## Sidebar"),
    (
        None,
        "Four panes: **Search** (full-text), **Sections** (heading tree, drag to reorder), **Tags** (every `#tag` with counts), **Backups** (daily SQLite snapshots — restore from any point in time).",
    ),
    (Some(2), "## Per-block history"),
    (
        None,
        "Every edit records a version. Open the block menu and pick **History** to browse and restore.",
    ),
    (Some(2), "## You're set"),
    (
        None,
        "Delete this intro when you're done — it's just regular blocks. Start writing below.",
    ),
];

pub struct Workspace {
    pub root: PathBuf,
    pub db: Connection,
}

#[derive(Default)]
pub struct AppState {
    inner: Arc<Mutex<Option<Workspace>>>,
}

impl AppState {
    pub fn open(&self, root: PathBuf) -> Result<()> {
        std::fs::create_dir_all(&root)?;
        std::fs::create_dir_all(root.join(".notesapp"))?;
        let mut conn = db::open(&root)?;

        // One-shot migration from a pre-SQLite-first workspace, if needed.
        Self::migrate_if_needed(&root, &mut conn)?;

        // Brand-new workspace? Seed intro blocks directly into the DB.
        let count: i64 =
            conn.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
        if count == 0 {
            Self::seed_intro(&mut conn)?;
        }

        *self.inner.lock() = Some(Workspace { root, db: conn });
        Ok(())
    }

    /// Drop the workspace and its DB connection. Used before moving the
    /// `.notesapp/` directory on disk.
    pub fn close(&self) {
        *self.inner.lock() = None;
    }

    /// Reopen the DB connection on the same workspace (used after restore).
    pub fn reopen_db(&self) -> Result<()> {
        let mut guard = self.inner.lock();
        let ws = guard.as_mut().ok_or(AppError::NoWorkspace)?;
        ws.db = db::open(&ws.root)?;
        Ok(())
    }

    fn migrate_if_needed(root: &std::path::Path, conn: &mut Connection) -> Result<()> {
        let current: i64 = db::get_setting(conn, "schema_version")?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        if current >= db::SCHEMA_VERSION {
            return Ok(());
        }

        let canvas = root.join("canvas.md");
        if canvas.exists() {
            let raw = std::fs::read_to_string(&canvas).unwrap_or_default();
            let parsed = crate::parser::migration::parse(&raw);
            let inputs: Vec<BlockInput> = parsed
                .into_iter()
                .map(|b| BlockInput {
                    id: b.id,
                    content: b.content,
                    position: b.position,
                    parent_id: b.parent_id,
                    heading: b.heading,
                    heading_level: b.heading_level,
                })
                .collect();
            if !inputs.is_empty() {
                db::save_snapshot(conn, &inputs, &[], "migration")?;
            }
            // Rename so the new app stops reading the old file but the user
            // can still inspect / recover it.
            let _ = std::fs::rename(&canvas, root.join("canvas.md.legacy-pre-sqlite"));
        }

        db::set_setting(
            conn,
            "schema_version",
            &db::SCHEMA_VERSION.to_string(),
        )?;
        Ok(())
    }

    fn seed_intro(conn: &mut Connection) -> Result<()> {
        let mut stack: Vec<(u8, String)> = Vec::new();
        let mut blocks: Vec<BlockInput> = Vec::with_capacity(INTRO_BLOCKS.len());
        for (pos, (heading_level, content)) in INTRO_BLOCKS.iter().enumerate() {
            let id = Ulid::new().to_string();
            let (heading, parent_id) = match heading_level {
                Some(lvl) => {
                    while stack.last().map_or(false, |(l, _)| *l >= *lvl) {
                        stack.pop();
                    }
                    let p = stack.last().map(|(_, id)| id.clone());
                    let heading_text = content.trim_start_matches('#').trim().to_string();
                    stack.push((*lvl, id.clone()));
                    (Some(heading_text), p)
                }
                None => (None, stack.last().map(|(_, id)| id.clone())),
            };
            blocks.push(BlockInput {
                id,
                content: content.to_string(),
                position: pos as i64,
                parent_id,
                heading,
                heading_level: *heading_level,
            });
        }
        db::save_snapshot(conn, &blocks, &[], "seed")?;
        Ok(())
    }

    pub fn with<R>(&self, f: impl FnOnce(&mut Workspace) -> Result<R>) -> Result<R> {
        let mut guard = self.inner.lock();
        let ws = guard.as_mut().ok_or(AppError::NoWorkspace)?;
        f(ws)
    }

    pub fn root(&self) -> Option<PathBuf> {
        self.inner.lock().as_ref().map(|w| w.root.clone())
    }
}

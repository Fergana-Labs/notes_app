# Mochi

A local-first notebook for macOS. One canvas, infinite blocks, full-text search, and SQLite under the hood.

Built with **Tauri 2** (Rust + native WebKit), **React 19**, **Tiptap 3**, and **rusqlite** with FTS5.

## Features

- **One-document canvas** — heading-aware ProseMirror editor with slash menu, bubble menu, drag-to-reorder, and an in-line bullet/numbered/task list system.
- **Inline hashtags** — type `#anything`, autocomplete from existing tags, and view aggregated tag pages with reorder / merge / split / group / delete actions.
- **Tags view** with three sort orders (Canvas / Newest / Oldest) and bulk actions:
  - **Group on canvas** — collect tagged blocks into a contiguous run on the main canvas.
  - **Merge** — combine selected blocks into one.
  - **Split** — break each top-level chunk (paragraph / heading / list item) of selected blocks into its own block.
  - **Export .md** — write selected blocks to a markdown file via save dialog.
  - **⌘Z undo** for every structural action above.
- **Search** — Slack-style top bar.
  - In **canvas view**: typing shows a read-only list of matching blocks; click jumps to the canvas.
  - In **tags view**: query inline-filters the visible block list (intersected with the active tag, if any).
- **Daily SQLite backups** — kept under `.notesapp/backups/`, browsable + restorable from Settings, with rolling 60-day retention.
- **Backup preview** — open any backup file as read-only and inspect block count, headings, and timestamps before restoring.
- **Per-block version history** — every content edit records a `block_versions` row; restorable via the block menu.
- **Workspace switcher / mover** — choose any folder, or move the current `.notesapp/` data to a new location.
- **Markdown export** — full-canvas export to `canvas.md` on demand.
- **Agent-friendly** — SQLite is the source of truth. Any agent (or `sqlite3` CLI) can write directly to `blocks.db` and Mochi picks up the changes within ~2s via an mtime poller.

## Architecture

### Storage

```
~/Library/Application Support/com.mochi.notes/default/
├── .notesapp/
│   ├── blocks.db              ← SQLite source of truth (WAL mode)
│   ├── blocks.db-wal
│   └── backups/
│       └── blocks-YYYY-MM-DD-HHMMSS.db
└── canvas.md.legacy-pre-sqlite ← (only on workspaces migrated from v1)
```

`blocks.db` schema (simplified):

```sql
blocks {
  id TEXT PK,                  -- ULID
  parent_id TEXT,              -- heading-tree parent
  position INTEGER,            -- canvas order
  heading TEXT, heading_level INTEGER,
  content TEXT,                -- block markdown
  content_hash TEXT,           -- sha256 of content
  tags TEXT (JSON),            -- derived from inline #tags
  manual_tags INTEGER,         -- legacy, always 0 in v0.1+
  created_at INTEGER, updated_at INTEGER
}

block_versions { id, block_id, content_hash, content, parent_hash, edited_at, source }
blocks_fts (FTS5 over content + tags + heading)
settings { key, value }   -- holds schema_version, etc.
```

Schema is currently at version 3. Migration from older versions runs once on app open.

### Save path

```
ProseMirror tx → snapshot blocks → ipc.saveBlocks(blocks, deletedIds)
                                 → Rust save_snapshot
                                 → UPSERT (skipping no-op rows)
                                 → re-extract hashtags
                                 → FTS sync + version snapshot if hash changed
```

Editing a block in the canvas debounces a per-block save through this same path (300 ms in canvas, 400 ms per row in tags view). Whole-canvas reconcile is gone — there's no markdown round-trip on save, only on explicit export.

### Frontend

- `src/App.tsx` — top-level layout, view-mode + tag-filter + search-query state.
- `src/editor/CanvasEditor.tsx` — Tiptap editor with the custom `mochiBlock` node, drag handles, slash + bubble menus, hashtag autocomplete.
- `src/tags-view/TagsView.tsx` — read/write block list, sort/filter/select/bulk-actions.
- `src/topbar/TopBarSearch.tsx` — controlled search input.
- `src/sidebar/Sidebar.tsx` — Canvas + Tags tabs with the heading tree and tag list.
- `src/settings/SettingsModal.tsx` — workspace + backups settings.
- `src/stores/workspace.ts` — Zustand store. Owns `blocks`, `tags`, `lastMtime`, and the tags-view undo stack.

### Backend (`src-tauri/`)

- `db.rs` — schema, queries, save snapshot, backup API.
- `parser.rs` — slim helpers (`hash`, `extract_hashtags`) plus a `migration` submodule used only when importing a pre-v2 `canvas.md`.
- `state.rs` — workspace open/close/reopen, schema migration, intro seeding.
- `commands.rs` — Tauri IPC: bootstrap, switch/move workspace, save_blocks, list/create/restore/preview backup, export canvas, write_text_file, blocks_mtime.
- `config.rs` — config file under app-data-dir tracking the active workspace path.

## Running locally

```bash
pnpm install
pnpm tauri dev
```

Default workspace lives at `~/Library/Application Support/com.mochi.notes/default/`. Switch or move it from **Settings → Workspace**.

### Tests

```bash
cd src-tauri && cargo test
```

(Currently exercises hashtag extraction + the legacy parser used only for migration.)

## Building a release DMG

Unsigned build (works on your machine; Gatekeeper warning on others):

```bash
pnpm tauri build
```

Output: `src-tauri/target/release/bundle/dmg/Mochi_<version>_<arch>.dmg`.

Universal (Apple Silicon + Intel) build:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
pnpm tauri build --target universal-apple-darwin
```

### Signed + notarized DMG (for public distribution)

You need an Apple Developer Program membership ($99/year) and a **Developer ID Application** certificate installed in Keychain.

1. **Copy the env template and fill it in:**
   ```bash
   cp .env.example .env.local
   ```
   Edit `.env.local` and set:
   - `APPLE_SIGNING_IDENTITY` — exact certificate name from Keychain (find with `security find-identity -p codesigning -v`)
   - `APPLE_ID` — your Apple ID email
   - `APPLE_PASSWORD` — an [app-specific password](https://appleid.apple.com), **not** your real Apple ID password
   - `APPLE_TEAM_ID` — your 10-character Team ID from [developer.apple.com → Membership](https://developer.apple.com/account)

   `.env.local` is gitignored so it never lands in commits.

2. **Run the release script:**
   ```bash
   ./scripts/release-mac.sh                     # current arch only
   ./scripts/release-mac.sh --universal         # Intel + Apple Silicon
   ```

   The script sources `.env.local`, runs `pnpm tauri build`, and Tauri picks up the env vars automatically — `codesign` runs first, then `xcrun notarytool`, then `xcrun stapler`. Resulting DMG installs cleanly on any Mac.

## License

[MIT](LICENSE) © 2026 Samuel Liu.

import { invoke } from "@tauri-apps/api/core";

export interface StoredBlock {
  id: string;
  parent_id: string | null;
  position: number;
  heading: string | null;
  heading_level: number | null;
  content: string;
  content_hash: string;
  /** Tags carried by this block, lowercased. Read-time projection
   *  from the normalized `tags` + `block_tags` tables; not stored on
   *  the block row itself. */
  tags: string[];
  /** Scopes in which the block is pinned. Empty string means the
   *  global "All blocks" view; any other value is a tag name. */
  pinned_scopes: string[];
  /** Optional user-set title shown in the card header. Null when the
   *  block has no title. */
  title: string | null;
  created_at: number;
  updated_at: number;
}

export interface BlockVersion {
  id: number;
  block_id: string;
  content_hash: string;
  content: string;
  parent_hash: string | null;
  edited_at: number;
  source: string;
}

export interface TagCount {
  tag: string;
  count: number;
  description: string;
  /** Explicit sort_order from tag_metadata (1-indexed). Null when the tag
   *  has never been reordered/described — those tags fall back to
   *  count-descending order at the end of the list. */
  sort_order: number | null;
  /** Folder name this tag is organized under in the sidebar, or null
   *  for root. Folders are visual-only — they never appear in the
   *  tag's name or in block content. */
  folder: string | null;
}

export interface DeleteTagResult {
  affected_block_ids: string[];
}

export interface SearchHit {
  id: string;
  heading: string | null;
  snippet: string;
}

export interface LoadResult {
  blocks: StoredBlock[];
  path: string;
}

export interface BackupHeading {
  id: string;
  heading: string;
  level: number;
  position: number;
}

export interface BackupPreview {
  block_count: number;
  total_chars: number;
  latest_updated_at: number;
  oldest_created_at: number;
  headings: BackupHeading[];
}

export interface BlockInput {
  id: string;
  content: string;
  position: number;
  parent_id?: string | null;
  heading?: string | null;
  heading_level?: number | null;
  /** Explicit tag set for this block. When present, it's merged with
   *  inline hashtags extracted from `content` to form the final tag
   *  set. When absent, the prior tag set is preserved (purely
   *  structural saves don't touch tags). */
  tags?: string[];
  /** Pin scope set. When absent, the prior set is preserved. When
   *  present, the entire set is replaced (pass an empty array to
   *  unpin everywhere). Empty string in the array = global pin. */
  pinned_scopes?: string[];
  /** Title overwrite. When absent the prior title is preserved.
   *  Empty string clears the title (NULL). */
  title?: string;
}

/** Canonical post-save state for a single block, returned from
 *  `save_blocks`. The frontend patches its store from these — content
 *  may differ from input (hashtags stripped) and `tags` reflects the
 *  merged final set. */
export interface SavedBlock {
  id: string;
  content: string;
  content_hash: string;
  tags: string[];
  pinned_scopes: string[];
  title: string | null;
  updated_at: number;
}

export interface SaveResult {
  saved: SavedBlock[];
  mtime: number;
}

export interface BackupInfo {
  name: string;
  timestamp: number;
  size_bytes: number;
}

export const ipc = {
  bootstrap: () => invoke<LoadResult>("bootstrap"),
  switchWorkspace: (path: string) =>
    invoke<LoadResult>("switch_workspace", { path }),
  moveWorkspace: (target: string) =>
    invoke<LoadResult>("move_workspace", { target }),
  workspacePath: () => invoke<string | null>("workspace_path"),
  listBlocks: () => invoke<StoredBlock[]>("list_blocks"),
  listBlocksByTag: (tag: string) =>
    invoke<StoredBlock[]>("list_blocks_by_tag", { tag }),
  listTags: () => invoke<TagCount[]>("list_tags"),
  setTagDescription: (name: string, description: string) =>
    invoke<void>("set_tag_description", { name, description }),
  reorderTags: (names: string[]) => invoke<void>("reorder_tags", { names }),
  setTagFolder: (name: string, folder: string | null) =>
    invoke<void>("set_tag_folder", { name, folder }),
  deleteTag: (name: string, mode: "strip" | "delete_blocks") =>
    invoke<DeleteTagResult>("delete_tag", { name, mode }),
  search: (query: string, limit = 50, caseSensitive = false) =>
    invoke<SearchHit[]>("search", {
      query,
      limit,
      caseSensitive,
    }),
  saveBlocks: (
    blocks: BlockInput[],
    deletedIds: string[] = [],
    source = "canvas",
  ) =>
    invoke<SaveResult>("save_blocks", {
      args: { blocks, deleted_ids: deletedIds, source },
    }),
  listVersions: (id: string) =>
    invoke<BlockVersion[]>("list_versions", { id }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),
  getSetting: (key: string) => invoke<string | null>("get_setting", { key }),
  setSetting: (key: string, value: string) =>
    invoke<void>("set_setting", { key, value }),
  createBackup: () => invoke<BackupInfo>("create_backup"),
  listBackups: () => invoke<BackupInfo[]>("list_backups"),
  restoreBackup: (name: string) =>
    invoke<StoredBlock[]>("restore_backup", { name }),
  previewBackup: (name: string) =>
    invoke<BackupPreview>("preview_backup", { name }),
  shouldBackup: () => invoke<boolean>("should_backup"),
  exportCanvas: () => invoke<string>("export_canvas"),
  blocksMtime: () => invoke<number>("blocks_mtime"),
};

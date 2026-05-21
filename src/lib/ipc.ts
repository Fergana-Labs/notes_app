import { invoke } from "@tauri-apps/api/core";

export interface StoredBlock {
  id: string;
  parent_id: string | null;
  position: number;
  heading: string | null;
  heading_level: number | null;
  content: string;
  content_hash: string;
  tags: string[];
  manual_tags: boolean;
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
}

export interface SaveResult {
  changed_ids: string[];
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

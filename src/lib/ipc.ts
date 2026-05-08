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
  blocks: StoredBlock[];
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
  search: (query: string, limit = 50) =>
    invoke<SearchHit[]>("search", { query, limit }),
  saveBlocks: (
    blocks: BlockInput[],
    deletedIds: string[] = [],
    source = "canvas",
  ) =>
    invoke<SaveResult>("save_blocks", {
      args: { blocks, deleted_ids: deletedIds, source },
    }),
  setBlockTags: (id: string, tags: string[], manual: boolean) =>
    invoke<void>("set_block_tags", { args: { id, tags, manual } }),
  listVersions: (id: string) =>
    invoke<BlockVersion[]>("list_versions", { id }),
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

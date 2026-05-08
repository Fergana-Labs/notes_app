import { create } from "zustand";
import { ipc, type BlockInput, type StoredBlock, type TagCount } from "../lib/ipc";

interface WorkspaceState {
  path: string | null;
  blocks: StoredBlock[];
  tags: TagCount[];
  loading: boolean;
  error: string | null;
  /** Last known mtime of blocks.db. Used by the agent-edit poller. */
  lastMtime: number;

  /** Boot: open the active workspace from config or the default location. */
  bootstrap: () => Promise<void>;
  /** Switch to a different workspace folder (no file move). */
  switchWorkspace: (path: string) => Promise<void>;
  /** Move the current `.notesapp/` data into `target` and reopen there. */
  moveWorkspace: (target: string) => Promise<void>;
  reload: () => Promise<void>;
  saveSnapshot: (blocks: BlockInput[], deletedIds?: string[]) => Promise<void>;
  setBlockTags: (id: string, tags: string[], manual: boolean) => Promise<void>;
  refreshTags: () => Promise<void>;
}

async function refreshAfterOpen(set: any, blocks: StoredBlock[], path: string) {
  const tags = await ipc.listTags();
  set({ path, blocks, tags, loading: false, error: null });
  ipc.shouldBackup().then((should) => {
    if (should) ipc.createBackup().catch(console.error);
  });
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  path: null,
  blocks: [],
  tags: [],
  loading: false,
  error: null,
  lastMtime: 0,

  bootstrap: async () => {
    set({ loading: true, error: null });
    try {
      const res = await ipc.bootstrap();
      await refreshAfterOpen(set, res.blocks, res.path);
    } catch (e: any) {
      set({ error: String(e), loading: false });
    }
  },

  switchWorkspace: async (path) => {
    set({ loading: true, error: null });
    try {
      const res = await ipc.switchWorkspace(path);
      await refreshAfterOpen(set, res.blocks, res.path);
    } catch (e: any) {
      set({ error: String(e), loading: false });
      throw e;
    }
  },

  moveWorkspace: async (target) => {
    set({ loading: true, error: null });
    try {
      const res = await ipc.moveWorkspace(target);
      await refreshAfterOpen(set, res.blocks, res.path);
    } catch (e: any) {
      set({ error: String(e), loading: false });
      throw e;
    }
  },

  reload: async () => {
    if (!get().path) return;
    const blocks = await ipc.listBlocks();
    const tags = await ipc.listTags();
    set({ blocks, tags });
  },

  saveSnapshot: async (blocks, deletedIds = []) => {
    const res = await ipc.saveBlocks(blocks, deletedIds);
    const tags = await ipc.listTags();
    set({ blocks: res.blocks, tags, lastMtime: res.mtime });
  },

  setBlockTags: async (id, tags, manual) => {
    await ipc.setBlockTags(id, tags, manual);
    set((s) => ({
      blocks: s.blocks.map((b) =>
        b.id === id ? { ...b, tags, manual_tags: manual } : b,
      ),
    }));
    const updated = await ipc.listTags();
    set({ tags: updated });
  },

  refreshTags: async () => {
    const tags = await ipc.listTags();
    set({ tags });
  },
}));

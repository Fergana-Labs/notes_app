import { create } from "zustand";
import { ipc, type BlockInput, type StoredBlock, type TagCount } from "../lib/ipc";

interface UndoEntry {
  /** Short label for diagnostics (not shown in UI yet). */
  label: string;
  /** Block snapshot to UPSERT to restore the prior state. */
  before: BlockInput[];
  /** IDs that existed before — used to compute which IDs to delete on undo. */
  beforeIds: string[];
}

interface WorkspaceState {
  path: string | null;
  blocks: StoredBlock[];
  tags: TagCount[];
  loading: boolean;
  error: string | null;
  /** Last known mtime of blocks.db. Used by the agent-edit poller. */
  lastMtime: number;
  /** Undo stack for tags-view structural actions. */
  undoStack: UndoEntry[];

  bootstrap: () => Promise<void>;
  switchWorkspace: (path: string) => Promise<void>;
  moveWorkspace: (target: string) => Promise<void>;
  reload: () => Promise<void>;
  saveSnapshot: (blocks: BlockInput[], deletedIds?: string[]) => Promise<void>;
  refreshTags: () => Promise<void>;

  /**
   * Capture the current blocks list and run `fn`. After `fn` resolves, push
   * the snapshot onto the undo stack so a later `undoLast()` can restore it.
   */
  runWithUndo: (label: string, fn: () => Promise<void>) => Promise<void>;
  undoLast: () => Promise<void>;
}

function snapshotBlocks(blocks: StoredBlock[]): BlockInput[] {
  return blocks.map((b) => ({
    id: b.id,
    content: b.content,
    position: b.position,
    parent_id: b.parent_id,
    heading: b.heading,
    heading_level: b.heading_level,
  }));
}

async function refreshAfterOpen(set: any, blocks: StoredBlock[], path: string) {
  const tags = await ipc.listTags();
  set({
    path,
    blocks,
    tags,
    loading: false,
    error: null,
    undoStack: [],
  });
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
  undoStack: [],

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

  refreshTags: async () => {
    const tags = await ipc.listTags();
    set({ tags });
  },

  runWithUndo: async (label, fn) => {
    const before = snapshotBlocks(get().blocks);
    const beforeIds = before.map((b) => b.id);
    await fn();
    set((s) => ({
      undoStack: [
        ...s.undoStack.slice(-49), // cap at 50 entries
        { label, before, beforeIds },
      ],
    }));
  },

  undoLast: async () => {
    const stack = get().undoStack;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];

    const beforeIdSet = new Set(entry.beforeIds);
    const currentIds = get().blocks.map((b) => b.id);
    const toDelete: string[] = [];
    for (const id of currentIds) if (!beforeIdSet.has(id)) toDelete.push(id);

    // Pop first so this undo doesn't accidentally re-push itself.
    set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));

    const res = await ipc.saveBlocks(entry.before, toDelete, "undo");
    const tags = await ipc.listTags();
    set({ blocks: res.blocks, tags, lastMtime: res.mtime });
  },
}));

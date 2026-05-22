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
    tags: b.tags,
    pinned_scopes: b.pinned_scopes,
    // Send the literal title back (empty string ↔ NULL clearing
    // via the BlockInput contract). undoLast wants to restore the
    // exact state, so an unset title needs an explicit "" to clear.
    title: b.title ?? "",
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

  saveSnapshot: async (input, deletedIds = []) => {
    const res = await ipc.saveBlocks(input, deletedIds);

    // Patch the in-memory `blocks` array from the server's canonical
    // post-save state. Content may differ from input (server strips
    // inline `#hashtag` tokens) and `tags` reflects the merged final
    // set — so we cannot derive these locally.
    set((s) => {
      if (res.saved.length === 0 && deletedIds.length === 0) {
        return { lastMtime: res.mtime };
      }
      const inputById = new Map(input.map((b) => [b.id, b]));
      const savedById = new Map(res.saved.map((b) => [b.id, b]));
      const deletedSet = new Set(deletedIds);
      const now = Date.now();

      const next: StoredBlock[] = [];
      const seen = new Set<string>();
      for (const existing of s.blocks) {
        if (deletedSet.has(existing.id)) continue;
        const inp = inputById.get(existing.id);
        const sv = savedById.get(existing.id);
        if (inp && sv) {
          next.push({
            ...existing,
            content: sv.content,
            content_hash: sv.content_hash,
            position: inp.position,
            parent_id: inp.parent_id ?? null,
            heading: inp.heading ?? null,
            heading_level: inp.heading_level ?? null,
            tags: sv.tags,
            pinned_scopes: sv.pinned_scopes,
            title: sv.title,
            updated_at: sv.updated_at,
          });
          seen.add(existing.id);
        } else {
          next.push(existing);
        }
      }
      // Brand-new blocks (id present in input but not in current state).
      for (const inp of input) {
        if (seen.has(inp.id)) continue;
        const sv = savedById.get(inp.id);
        if (!sv) continue;
        next.push({
          id: inp.id,
          parent_id: inp.parent_id ?? null,
          position: inp.position,
          heading: inp.heading ?? null,
          heading_level: inp.heading_level ?? null,
          content: sv.content,
          content_hash: sv.content_hash,
          tags: sv.tags,
          pinned_scopes: sv.pinned_scopes,
          title: sv.title,
          created_at: now,
          updated_at: sv.updated_at,
        });
      }
      next.sort((a, b) => a.position - b.position);
      return { blocks: next, lastMtime: res.mtime };
    });

    // The tags pane reads aggregated counts from the DB. Refresh only
    // when the save plausibly changed the tag set — content edits,
    // explicit tag changes via BlockInput.tags, or deletions can all
    // shift counts. Pure-position reorders cannot.
    const tagSetMaybeChanged =
      input.some((b) => b.tags !== undefined) ||
      deletedIds.length > 0 ||
      res.saved.length > 0;
    if (tagSetMaybeChanged) {
      const tags = await ipc.listTags();
      set({ tags });
    }
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

    // Pop first so this undo doesn't accidentally re-push itself onto the
    // stack via `saveSnapshot` running.
    set((s) => ({ undoStack: s.undoStack.slice(0, -1) }));
    await get().saveSnapshot(entry.before, toDelete);
  },
}));

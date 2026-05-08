import { create } from "zustand";
import { ipc, type BlockInput, type StoredBlock, type TagCount } from "../lib/ipc";
import { extractInlineTags } from "../lib/markdown";

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

function localContentHash(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `local:${(hash >>> 0).toString(36)}:${content.length}`;
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

  saveSnapshot: async (saved, deletedIds = []) => {
    const res = await ipc.saveBlocks(saved, deletedIds);

    // Patch the in-memory `blocks` array from the input batch instead of
    // refetching the whole table. For a 2k-block doc this turns every save
    // from a 2k-row IPC response + array replacement into a few rows
    // updated in place.
    set((s) => {
      if (saved.length === 0 && deletedIds.length === 0) {
        return { lastMtime: res.mtime };
      }
      const inputById = new Map(saved.map((b) => [b.id, b]));
      const deletedSet = new Set(deletedIds);
      const now = Date.now();

      const next: StoredBlock[] = [];
      const seen = new Set<string>();
      for (const existing of s.blocks) {
        if (deletedSet.has(existing.id)) continue;
        const input = inputById.get(existing.id);
        if (input) {
          const contentChanged = input.content !== existing.content;
          next.push({
            ...existing,
            content: input.content,
            content_hash: contentChanged
              ? localContentHash(input.content)
              : existing.content_hash,
            position: input.position,
            parent_id: input.parent_id ?? null,
            heading: input.heading ?? null,
            heading_level: input.heading_level ?? null,
            tags: extractInlineTags(input.content),
            updated_at: now,
          });
          seen.add(existing.id);
        } else {
          next.push(existing);
        }
      }
      // Brand-new blocks (id present in input but not in current state).
      for (const input of saved) {
        if (seen.has(input.id)) continue;
        next.push({
          id: input.id,
          parent_id: input.parent_id ?? null,
          position: input.position,
          heading: input.heading ?? null,
          heading_level: input.heading_level ?? null,
          content: input.content,
          content_hash: localContentHash(input.content),
          tags: extractInlineTags(input.content),
          manual_tags: false,
          created_at: now,
          updated_at: now,
        });
      }
      next.sort((a, b) => a.position - b.position);
      return { blocks: next, lastMtime: res.mtime };
    });

    // The tags pane reads aggregated counts from the DB. Refresh only when
    // an actual change happened — pure reorders / no-op saves don't change
    // the tag counts.
    if (res.changed_ids.length > 0 || deletedIds.length > 0) {
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

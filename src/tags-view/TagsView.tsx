import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
// @ts-expect-error — no shipped types for markdown-it-task-lists
import taskLists from "markdown-it-task-lists";
import {
  Combine,
  Trash2,
  GripVertical,
  AlignVerticalSpaceAround,
  ArrowRight,
  X,
  Plus,
  SplitSquareVertical,
  Download,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";

const renderMd = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
}).use(taskLists, { enabled: true, label: false });
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { ulid } from "ulid";
import { ipc, type BlockInput, type StoredBlock } from "../lib/ipc";
import { useWorkspace } from "../stores/workspace";
import { debounce } from "../lib/debounce";
import { unescapeInlineHashtags } from "../lib/markdown";
import { Hashtag } from "../editor/extensions/Hashtag";
import { HashtagHighlight } from "../editor/extensions/HashtagHighlight";

type Sort = "canvas" | "newest" | "oldest";

const TAG_ROW_ESTIMATE = 132;
const TAG_ROW_GAP = 8;
const TAG_ROW_OVERSCAN = 8;

interface VirtualItem<T> {
  item: T;
  start: number;
}

function findIndexAtOffset(offsets: number[], value: number): number {
  if (offsets.length === 0) return 0;
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= value) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function useVirtualRows<T extends { id: string }>(
  items: T[],
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  listRef: React.RefObject<HTMLDivElement | null>,
  layoutKey: string,
) {
  const sizeByIdRef = useRef(new Map<string, number>());
  const observersRef = useRef(new Map<string, { disconnect: () => void }>());
  const [sizeVersion, setSizeVersion] = useState(0);
  const [metrics, setMetrics] = useState({ scrollTop: 0, viewportHeight: 0 });

  const updateMetrics = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const list = listRef.current;
    const listTop = list
      ? list.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop
      : 0;
    const next = {
      scrollTop: Math.max(0, scroller.scrollTop - listTop),
      viewportHeight: scroller.clientHeight,
    };
    setMetrics((prev) =>
      prev.scrollTop === next.scrollTop &&
      prev.viewportHeight === next.viewportHeight
        ? prev
        : next,
    );
  }, [listRef, scrollerRef]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateMetrics();
      });
    };

    updateMetrics();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scroller);
    if (listRef.current) resizeObserver.observe(listRef.current);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      resizeObserver.disconnect();
    };
  }, [listRef, scrollerRef, updateMetrics]);

  useEffect(() => {
    updateMetrics();
  }, [items.length, layoutKey, sizeVersion, updateMetrics]);

  useEffect(
    () => () => {
      for (const observer of observersRef.current.values()) {
        observer.disconnect();
      }
      observersRef.current.clear();
    },
    [],
  );

  const layout = useMemo(() => {
    const offsets: number[] = [];
    const sizes: number[] = [];
    let totalSize = 0;
    for (const item of items) {
      offsets.push(totalSize);
      const size = sizeByIdRef.current.get(item.id) ?? TAG_ROW_ESTIMATE;
      sizes.push(size);
      totalSize += size;
    }
    return { offsets, sizes, totalSize };
  }, [items, sizeVersion]);

  const virtualItems = useMemo(() => {
    if (items.length === 0) return [] as VirtualItem<T>[];

    const overscanPx = TAG_ROW_ESTIMATE * TAG_ROW_OVERSCAN;
    const fromPx = Math.max(0, metrics.scrollTop - overscanPx);
    const toPx = Math.min(
      layout.totalSize,
      metrics.scrollTop + metrics.viewportHeight + overscanPx,
    );
    const startIndex = Math.max(
      0,
      findIndexAtOffset(layout.offsets, fromPx) - TAG_ROW_OVERSCAN,
    );
    const endIndex = Math.min(
      items.length - 1,
      findIndexAtOffset(layout.offsets, toPx) + TAG_ROW_OVERSCAN,
    );

    const out: VirtualItem<T>[] = [];
    for (let index = startIndex; index <= endIndex; index++) {
      out.push({
        item: items[index],
        start: layout.offsets[index],
      });
    }
    return out;
  }, [items, layout, metrics]);

  const measureElement = useCallback((id: string, el: HTMLDivElement | null) => {
    observersRef.current.get(id)?.disconnect();
    observersRef.current.delete(id);
    if (!el) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = el.getBoundingClientRect().height;
      if (next <= 0) return;
      const prev = sizeByIdRef.current.get(id);
      if (prev == null || Math.abs(prev - next) > 1) {
        sizeByIdRef.current.set(id, next);
        setSizeVersion((v) => v + 1);
      }
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    schedule();
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(el);
    observersRef.current.set(id, {
      disconnect: () => {
        if (frame) cancelAnimationFrame(frame);
        resizeObserver.disconnect();
      },
    });
  }, []);

  return {
    totalSize: layout.totalSize,
    virtualItems,
    measureElement,
  };
}

function virtualRowStyle(start: number): React.CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${start}px)`,
    paddingBottom: TAG_ROW_GAP,
    boxSizing: "border-box",
  };
}

interface Props {
  tagFilter: string | null;
  /**
   * Free-text search query. Empty string = no search. Filters the visible
   * block list to FTS hits intersected with whatever tag scope is active.
   */
  searchQuery: string;
  /**
   * Read-only mode: rows render as static markdown previews and clicking a
   * row calls `onJumpToBlock`. No Tiptap editor mounts, no bulk actions, no
   * drag/select. Used for canvas-mode search results.
   */
  readOnly?: boolean;
  onClearFilter: () => void;
  onClearSearch: () => void;
  onJumpToBlock: (id: string) => void;
}

function asBlockInput(b: StoredBlock, override?: Partial<BlockInput>): BlockInput {
  return {
    id: b.id,
    content: override?.content ?? b.content,
    position: override?.position ?? b.position,
    parent_id: override?.parent_id ?? b.parent_id,
    heading: override?.heading ?? b.heading,
    heading_level: override?.heading_level ?? b.heading_level,
  };
}

/**
 * Walk a position-ordered block list and assign `parent_id` based on
 * heading-level nesting (same rule as the canvas-side parser). Used after
 * any global reorder so heading subtrees stay coherent.
 */
function recomputeParentIds<T extends BlockInput>(ordered: T[]): T[] {
  const stack: { id: string; level: number }[] = [];
  return ordered.map((b) => {
    if (b.heading_level != null) {
      while (stack.length && stack[stack.length - 1].level >= b.heading_level) {
        stack.pop();
      }
      const parent_id = stack.length ? stack[stack.length - 1].id : null;
      stack.push({ id: b.id, level: b.heading_level });
      return { ...b, parent_id };
    }
    return {
      ...b,
      parent_id: stack.length ? stack[stack.length - 1].id : null,
    };
  });
}

/**
 * Heuristic markdown splitter. Each top-level chunk (paragraph, heading, or
 * list item) becomes its own block. Fenced code stays whole.
 */
function splitContentIntoChunks(content: string): string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    if (current.length > 0 && current.some((l) => l.trim().length > 0)) {
      chunks.push(current.join("\n").trim());
    }
    current = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (!inFence) flush();
      current.push(line);
      inFence = !inFence;
      if (!inFence) flush();
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      chunks.push(line.trim());
      continue;
    }
    if (/^\s*#{1,6}\s+/.test(line)) {
      flush();
      chunks.push(line.trim());
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return chunks;
}

/**
 * Strip every inline occurrence of `#tag` from a block's markdown content.
 * Matches `#tag` only when not followed by another tag-name character (so
 * removing `#foo` doesn't touch `#foobar`). Collapses doubled spaces and
 * blank lines that the removal leaves behind.
 */
function stripTagFromContent(content: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`#${escaped}(?![A-Za-z0-9_\\-/])`, "gi");
  return content
    .replace(re, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Read/write aggregation view of blocks. Shows every block by default;
 * `tagFilter` narrows to a single tag.
 *
 * Each row is its own Tiptap editor (markdown via tiptap-markdown), so edits
 * happen in place — no jumping back to the canvas to fix typos.
 *
 * "+ Add block" appends a new block to the canvas. If a tag filter is active,
 * the new block starts with `#tag ` so it shows up in this view immediately.
 */
export function TagsView({
  tagFilter,
  searchQuery,
  readOnly = false,
  onClearFilter,
  onClearSearch,
  onJumpToBlock,
}: Props) {
  const blocks = useWorkspace((s) => s.blocks);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);
  const runWithUndo = useWorkspace((s) => s.runWithUndo);

  const [sort, setSort] = useState<Sort>("canvas");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  // Set of block IDs matching the active FTS query, or null when no query.
  const [searchHitIds, setSearchHitIds] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Debounced FTS lookup. We intersect the result IDs with the visible block
  // list — the actual list rendering still uses the full `StoredBlock` data
  // we already have in memory (so we keep editor mounts, undo, etc.).
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchHitIds(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      ipc
        .search(q, 200)
        .then((hits) => setSearchHitIds(new Set(hits.map((h) => h.id))))
        .catch(() => setSearchHitIds(new Set()))
        .finally(() => setSearching(false));
    }, 150);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const filtered = useMemo(() => {
    let arr = blocks;
    if (tagFilter) {
      const needle = tagFilter.toLowerCase();
      arr = arr.filter((b) => b.tags.includes(needle));
    }
    if (searchHitIds) {
      arr = arr.filter((b) => searchHitIds.has(b.id));
    }
    return arr;
  }, [blocks, tagFilter, searchHitIds]);

  const sortedByMode = useMemo(() => {
    const arr = [...filtered];
    if (sort === "canvas") arr.sort((a, b) => a.position - b.position);
    else if (sort === "newest") arr.sort((a, b) => b.updated_at - a.updated_at);
    else arr.sort((a, b) => a.updated_at - b.updated_at);
    return arr;
  }, [filtered, sort]);

  const visible = useMemo(() => {
    if (!localOrder) return sortedByMode;
    const byId = new Map(sortedByMode.map((b) => [b.id, b]));
    const out: StoredBlock[] = [];
    for (const id of localOrder) {
      const b = byId.get(id);
      if (b) {
        out.push(b);
        byId.delete(id);
      }
    }
    for (const b of sortedByMode) if (byId.has(b.id)) out.push(b);
    return out;
  }, [sortedByMode, localOrder]);

  useEffect(() => {
    setLocalOrder(null);
  }, [sort, tagFilter]);

  useEffect(() => {
    setSelected((prev) => {
      const next = new Set<string>();
      const visibleIds = new Set(visible.map((b) => b.id));
      for (const id of prev) if (visibleIds.has(id)) next.add(id);
      return next;
    });
  }, [visible]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const virtualLayoutKey = [
    readOnly ? "readonly" : "editable",
    selected.size,
    searching ? "searching" : "idle",
    sort,
    tagFilter ?? "",
    searchQuery,
  ].join(":");
  const { totalSize, virtualItems, measureElement } = useVirtualRows(
    visible,
    scrollRef,
    listRef,
    virtualLayoutKey,
  );

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const persistMode: "slot-swap" | "renumber" | "ephemeral" = tagFilter
    ? "slot-swap"
    : sort === "canvas"
      ? "renumber"
      : "ephemeral";

  const handleDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = visible.map((b) => b.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));

    if (persistMode === "ephemeral") {
      setLocalOrder(next);
      return;
    }

    if (persistMode === "slot-swap") {
      await runWithUndo("Reorder", async () => {
        const slots = visible.map((b) => b.position).sort((a, b) => a - b);
        const updates: BlockInput[] = next.map((id, idx) => {
          const b = blocks.find((x) => x.id === id)!;
          return asBlockInput(b, { position: slots[idx] });
        });
        await saveSnapshot(updates, []);
      });
      return;
    }

    await runWithUndo("Reorder", async () => {
      const updates = recomputeParentIds(
        next.map((id, i) => {
          const b = blocks.find((x) => x.id === id)!;
          return asBlockInput(b, { position: i });
        }),
      );
      await saveSnapshot(updates, []);
    });
  };

  const groupSelected = async () => {
    if (selected.size < 2) return;
    await runWithUndo("Group", async () => {
      const selectedInOrder = visible.filter((b) => selected.has(b.id));
      const ids = new Set(selectedInOrder.map((b) => b.id));
      const firstPos = Math.min(...selectedInOrder.map((b) => b.position));

      const allByPos = [...blocks].sort((a, b) => a.position - b.position);
      const before = allByPos.filter((b) => b.position < firstPos && !ids.has(b.id));
      const after = allByPos.filter((b) => b.position >= firstPos && !ids.has(b.id));
      const reordered = [...before, ...selectedInOrder, ...after];

      const updates = recomputeParentIds(
        reordered.map((b, i) => asBlockInput(b, { position: i })),
      );
      await saveSnapshot(updates, []);
    });
  };

  const mergeSelected = async () => {
    if (selected.size < 2) return;
    const selectedInOrder = visible.filter((b) => selected.has(b.id));
    const keep = [...selectedInOrder].sort((a, b) => a.position - b.position)[0];
    const others = selectedInOrder.filter((b) => b.id !== keep.id);
    if (
      !window.confirm(
        `Merge ${selectedInOrder.length} blocks into one?\n\n` +
          `The merged block lands at the canvas position of the earliest selected block. ` +
          `Content is joined in this view's order. The other selected blocks are deleted.`,
      )
    )
      return;
    await runWithUndo("Merge", async () => {
      const merged = selectedInOrder.map((b) => b.content).join("\n\n");
      await saveSnapshot(
        [asBlockInput(keep, { content: merged })],
        others.map((b) => b.id),
      );
    });
    setSelected(new Set());
  };

  const removeFromTag = async (id: string) => {
    if (!tagFilter) return;
    const b = blocks.find((x) => x.id === id);
    if (!b) return;
    await runWithUndo("Remove tag", async () => {
      const newContent = stripTagFromContent(b.content, tagFilter);
      await saveSnapshot([asBlockInput(b, { content: newContent })], []);
    });
  };

  const removeTagFromSelected = async () => {
    if (!tagFilter || selected.size === 0) return;
    await runWithUndo("Remove tag", async () => {
      const ids = visible.filter((b) => selected.has(b.id)).map((b) => b.id);
      const updates: BlockInput[] = ids.map((id) => {
        const b = blocks.find((x) => x.id === id)!;
        return asBlockInput(b, {
          content: stripTagFromContent(b.content, tagFilter),
        });
      });
      await saveSnapshot(updates, []);
    });
    setSelected(new Set());
  };

  /**
   * For each selected block, split its content into multiple blocks — one
   * per top-level chunk (paragraph, heading, list item). Fenced code stays
   * whole. The original block keeps its ID and history (becomes the first
   * chunk); subsequent chunks are fresh blocks immediately after.
   */
  const splitSelected = async () => {
    if (selected.size === 0) return;
    // Pre-check whether any selected block actually has multiple chunks.
    const willSplit = blocks.some(
      (b) =>
        selected.has(b.id) && splitContentIntoChunks(b.content).length > 1,
    );
    if (!willSplit) {
      window.alert(
        "Nothing to split — selected blocks are already a single chunk each.",
      );
      return;
    }
    await runWithUndo("Split", async () => {
      const allByPos = [...blocks].sort((a, b) => a.position - b.position);
      const updates: BlockInput[] = [];
      let pos = 0;
      for (const b of allByPos) {
        if (selected.has(b.id)) {
          const chunks = splitContentIntoChunks(b.content);
          if (chunks.length <= 1) {
            updates.push(asBlockInput(b, { position: pos++ }));
            continue;
          }
          // First chunk → original block (keeps id + version history).
          updates.push(asBlockInput(b, { content: chunks[0], position: pos++ }));
          for (let i = 1; i < chunks.length; i++) {
            updates.push({
              id: ulid(),
              content: chunks[i],
              position: pos++,
              parent_id: b.parent_id,
              heading: null,
              heading_level: null,
            });
          }
        } else {
          updates.push(asBlockInput(b, { position: pos++ }));
        }
      }
      await saveSnapshot(recomputeParentIds(updates), []);
    });
    setSelected(new Set());
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (
      !window.confirm(
        `Delete ${selected.size} block${selected.size === 1 ? "" : "s"}?\n\nThis removes them from the canvas entirely. (⌘Z undoes.)`,
      )
    )
      return;
    await runWithUndo("Delete", async () => {
      await saveSnapshot([], Array.from(selected));
    });
    setSelected(new Set());
  };

  /**
   * Export selected blocks as a single markdown file. Joins each block's
   * content with a blank line; file path is picked via the save dialog.
   * Read-only operation — not pushed onto the undo stack.
   */
  const exportSelected = async () => {
    if (selected.size === 0) return;
    const selectedInOrder = visible.filter((b) => selected.has(b.id));
    const md = selectedInOrder.map((b) => b.content).join("\n\n");
    const stamp = new Date().toISOString().slice(0, 10);
    const defaultName = tagFilter
      ? `mochi-${tagFilter}-${stamp}.md`
      : `mochi-export-${stamp}.md`;
    const picked = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof picked !== "string") return;
    await ipc.writeTextFile(picked, md);
  };

  const addBlock = async () => {
    await runWithUndo("Add block", async () => {
      const sortedAll = [...blocks].sort((a, b) => a.position - b.position);
      const last = sortedAll[sortedAll.length - 1];
      const newPos = (last?.position ?? -1) + 1;
      const id = ulid();
      const content = tagFilter ? `#${tagFilter} ` : "";
      await saveSnapshot(
        [
          {
            id,
            content,
            position: newPos,
            parent_id: last?.parent_id ?? null,
            heading: null,
            heading_level: null,
          },
        ],
        [],
      );
      setPendingFocusId(id);
    });
  };

  const deleteBlock = async (id: string) => {
    if (!window.confirm("Delete this block? (⌘Z undoes.)")) return;
    await runWithUndo("Delete", async () => {
      await saveSnapshot([], [id]);
    });
  };

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 pt-4 pb-12">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          {tagFilter ? (
            <h1 className="text-xl font-bold flex items-center gap-2">
              #{tagFilter}
              <button
                onClick={onClearFilter}
                title="Clear tag filter (show all blocks)"
                className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
              >
                <X size={14} />
              </button>
            </h1>
          ) : (
            <h1 className="text-xl font-bold">All blocks</h1>
          )}
          {searchQuery.trim() && (
            <span className="flex items-center gap-1 text-sm px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-200">
              search: <span className="font-mono">{searchQuery.trim()}</span>
              <button
                onClick={onClearSearch}
                title="Clear search"
                className="ml-1 hover:text-amber-900 dark:hover:text-amber-100"
              >
                <X size={12} />
              </button>
            </span>
          )}
          <span className="text-sm text-neutral-500">
            {searching
              ? "searching…"
              : `${visible.length} block${visible.length === 1 ? "" : "s"}`}
          </span>

          <div className="ml-auto flex items-center gap-2">
            {!readOnly && (
              <button
                onClick={addBlock}
                title={
                  tagFilter
                    ? `Add a new block tagged #${tagFilter}`
                    : "Add a new block at the end of the canvas"
                }
                className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Plus size={13} /> Add block
              </button>
            )}
            <SortToggle value={sort} onChange={setSort} />
          </div>
        </div>

        {!readOnly && selected.size > 0 && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-900/20 text-sm">
            <span className="text-blue-900 dark:text-blue-200">
              {selected.size} selected
            </span>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-blue-700 dark:text-blue-300 hover:underline"
            >
              clear
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={groupSelected}
                disabled={selected.size < 2}
                title="Move selected blocks to be contiguous on the canvas"
                className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
              >
                <AlignVerticalSpaceAround size={13} /> Group on canvas
              </button>
              <button
                onClick={mergeSelected}
                disabled={selected.size < 2}
                title="Combine selected blocks into one"
                className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-40"
              >
                <Combine size={13} /> Merge
              </button>
              <button
                onClick={splitSelected}
                title="Split each selected block by its top-level chunks (paragraphs / list items / headings)"
                className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <SplitSquareVertical size={13} /> Split
              </button>
              <button
                onClick={exportSelected}
                title="Export selected blocks as a markdown file"
                className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <Download size={13} /> Export .md
              </button>
              {tagFilter && (
                <button
                  onClick={removeTagFromSelected}
                  title={`Strip #${tagFilter} from each selected block (keeps the blocks)`}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-amber-300 dark:border-amber-700 bg-white dark:bg-neutral-900 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30"
                >
                  <X size={13} /> Remove #{tagFilter}
                </button>
              )}
              <button
                onClick={deleteSelected}
                title="Delete selected blocks from the canvas entirely"
                className="flex items-center gap-1 text-xs px-2 py-1 rounded bg-red-600 hover:bg-red-700 text-white"
              >
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
        )}

        {visible.length === 0 && !searching && (
          <p className="text-sm text-neutral-500 italic">
            {searchQuery.trim()
              ? tagFilter
                ? `No matches for "${searchQuery.trim()}" in #${tagFilter}.`
                : `No matches for "${searchQuery.trim()}".`
              : tagFilter
                ? `No blocks tagged with #${tagFilter}.`
                : "No blocks yet."}
          </p>
        )}

        {readOnly ? (
          <div
            ref={listRef}
            style={{ height: totalSize, position: "relative" }}
          >
            {virtualItems.map(({ item: b, start }) => (
              <div
                key={b.id}
                ref={(el) => measureElement(b.id, el)}
                style={virtualRowStyle(start)}
              >
                <ReadOnlyRow
                  block={b}
                  onJump={() => onJumpToBlock(b.id)}
                />
              </div>
            ))}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visible.map((b) => b.id)}
              strategy={verticalListSortingStrategy}
            >
              <div
                ref={listRef}
                style={{ height: totalSize, position: "relative" }}
              >
                {virtualItems.map(({ item: b, start }) => (
                  <div
                    key={b.id}
                    ref={(el) => measureElement(b.id, el)}
                    style={virtualRowStyle(start)}
                  >
                    <BlockRow
                      block={b}
                      tagFilter={tagFilter}
                      selected={selected.has(b.id)}
                      autoFocus={pendingFocusId === b.id}
                      onAutoFocused={() => setPendingFocusId(null)}
                      dragHint={
                        persistMode === "ephemeral"
                          ? "Drag to rearrange in this view (Group on canvas to commit)"
                          : persistMode === "slot-swap"
                            ? `Drag to reorder among #${tagFilter} blocks on the canvas`
                            : "Drag to reorder on canvas"
                      }
                      onSelect={() => toggleSelect(b.id)}
                      onRemoveTag={() => removeFromTag(b.id)}
                      onJump={() => onJumpToBlock(b.id)}
                      onDelete={() => deleteBlock(b.id)}
                    />
                  </div>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

/**
 * Read-only row used by canvas-mode search results. Renders the block's
 * markdown statically — clicking anywhere jumps to that block on the canvas.
 */
function ReadOnlyRow({
  block,
  onJump,
}: {
  block: StoredBlock;
  onJump: () => void;
}) {
  const html = useMemo(
    () => renderMd.render(block.content || ""),
    [block.content],
  );

  return (
    <button
      onClick={onJump}
      className="group w-full text-left rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 hover:border-blue-400 dark:hover:border-blue-600 transition-colors"
    >
      <div className="flex items-center gap-2 px-3 py-1 text-xs text-neutral-500 border-b border-neutral-100 dark:border-neutral-800">
        {block.heading && (
          <span className="truncate font-semibold text-neutral-700 dark:text-neutral-200">
            {block.heading}
          </span>
        )}
        <span className="ml-auto text-[10px]">
          {new Date(block.updated_at).toLocaleString()}
        </span>
        <ArrowRight
          size={13}
          className="text-neutral-400 invisible group-hover:visible"
        />
      </div>
      <div
        className="prose-block px-4 py-3 text-sm pointer-events-none"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </button>
  );
}

function SortToggle({
  value,
  onChange,
}: {
  value: Sort;
  onChange: (s: Sort) => void;
}) {
  const opts: { v: Sort; l: string }[] = [
    { v: "canvas", l: "Canvas" },
    { v: "newest", l: "Newest" },
    { v: "oldest", l: "Oldest" },
  ];
  return (
    <div className="inline-flex items-center rounded border border-neutral-200 dark:border-neutral-800 overflow-hidden text-xs">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 transition-colors ${
            value === o.v
              ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function BlockRow({
  block,
  tagFilter,
  selected,
  autoFocus,
  onAutoFocused,
  dragHint,
  onSelect,
  onRemoveTag,
  onJump,
  onDelete,
}: {
  block: StoredBlock;
  tagFilter: string | null;
  selected: boolean;
  autoFocus: boolean;
  onAutoFocused: () => void;
  dragHint: string;
  onSelect: () => void;
  onRemoveTag: () => void;
  onJump: () => void;
  onDelete: () => void;
}) {
  // Lazy edit: the row renders as a static markdown preview by default.
  // We only mount Tiptap when the user actually wants to edit (click the
  // body, or autoFocus from `+ Add block`). With 2k blocks this turns
  // "switch to tags view" from a 2k-Tiptap-instance startup into a static
  // HTML render — orders of magnitude faster.
  const [editing, setEditing] = useState(autoFocus);

  useEffect(() => {
    if (autoFocus) {
      setEditing(true);
      onAutoFocused();
    }
  }, [autoFocus, onAutoFocused]);

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`group rounded-lg border bg-white dark:bg-neutral-900 ${
        selected
          ? "border-blue-400 dark:border-blue-600 ring-1 ring-blue-200 dark:ring-blue-800"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-neutral-500 border-b border-neutral-100 dark:border-neutral-800">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          title={dragHint}
        >
          <GripVertical size={14} />
        </button>
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          className="cursor-pointer"
        />
        <span className="font-mono text-[10px]">{block.id.slice(-8)}</span>
        {block.heading && <span className="truncate">— {block.heading}</span>}
        <span className="ml-auto text-[10px]">
          {new Date(block.updated_at).toLocaleString()}
        </span>
        <button
          onClick={onJump}
          title="Open in canvas"
          className="invisible group-hover:visible p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <ArrowRight size={13} />
        </button>
        {tagFilter && (
          <button
            onClick={onRemoveTag}
            title={`Remove #${tagFilter} from this block`}
            className="invisible group-hover:visible p-1 rounded hover:bg-amber-50 dark:hover:bg-amber-900/30 text-amber-600"
          >
            <X size={13} />
          </button>
        )}
        <button
          onClick={onDelete}
          title="Delete this block"
          className="invisible group-hover:visible p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {editing ? (
        <EditableBody
          block={block}
          onBlurOut={() => setEditing(false)}
        />
      ) : (
        <ReadOnlyBody
          block={block}
          onActivate={() => setEditing(true)}
        />
      )}
    </article>
  );
}

function ReadOnlyBody({
  block,
  onActivate,
}: {
  block: StoredBlock;
  onActivate: () => void;
}) {
  const html = useMemo(
    () => renderMd.render(block.content || ""),
    [block.content],
  );

  return (
    <div
      onClick={onActivate}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className="prose-block px-4 py-3 text-sm cursor-text"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function EditableBody({
  block,
  onBlurOut,
}: {
  block: StoredBlock;
  onBlurOut: () => void;
}) {
  const tags = useWorkspace((s) => s.tags);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);
  const tagsRef = useRef(tags);
  useEffect(() => { tagsRef.current = tags; }, [tags]);

  const blockRef = useRef(block);
  useEffect(() => { blockRef.current = block; }, [block]);
  const saveSnapshotRef = useRef(saveSnapshot);
  useEffect(() => { saveSnapshotRef.current = saveSnapshot; }, [saveSnapshot]);

  const saveDebounced = useMemo(
    () =>
      debounce((md: string) => {
        const b = blockRef.current;
        const cleaned = unescapeInlineHashtags(md);
        void saveSnapshotRef.current(
          [asBlockInput(b, { content: cleaned })],
          [],
        );
      }, 400),
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: "mochi-link" },
        },
      }),
      Markdown.configure({ html: false, linkify: true, breaks: false }),
      Placeholder.configure({
        placeholder: "Empty block — start typing…",
        showOnlyWhenEditable: true,
      }),
      Hashtag.configure({
        getTags: () => tagsRef.current.map((t) => t.tag),
      }),
      HashtagHighlight,
    ],
    content: block.content,
    autofocus: "end",
    onUpdate: ({ editor }) => {
      const md: string = (editor.storage as any).markdown.getMarkdown();
      saveDebounced(md);
    },
    onBlur: () => {
      // Flush any pending save before falling back to the read-only view.
      saveDebounced.flush();
      onBlurOut();
    },
  });

  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const current: string =
      (editor.storage as any).markdown?.getMarkdown?.() ?? "";
    if (current.trim() !== block.content.trim()) {
      editor.commands.setContent(block.content, { emitUpdate: false });
    }
  }, [block.content, editor]);

  useEffect(() => () => saveDebounced.flush(), [saveDebounced]);

  return (
    <div className="px-4 py-3 text-sm">
      <EditorContent editor={editor} />
    </div>
  );
}

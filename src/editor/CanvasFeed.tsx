import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlignVerticalSpaceAround,
  ArrowLeft,
  CheckSquare,
  Combine,
  Download,
  GripVertical,
  Maximize2,
  MoreHorizontal,
  Pin,
  Plus,
  SplitSquareVertical,
  Trash2,
  X,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import UnderlineExtension from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { ulid } from "ulid";
import type { Editor } from "@tiptap/core";
import { useWorkspace } from "../stores/workspace";
import { useUISettings } from "../stores/uiSettings";
import { ipc, type BlockInput, type StoredBlock } from "../lib/ipc";
import { debounce } from "../lib/debounce";
import { unescapeInlineHashtags } from "../lib/markdown";
import { Hashtag } from "./extensions/Hashtag";
import { SlashMenu } from "./extensions/SlashMenu";
import { BlockBubbleMenu } from "./BubbleMenu";
import { BlockMenu } from "./BlockMenu";
import { VersionHistoryModal } from "./VersionHistoryModal";
import { BLOCK_TYPES } from "./blockTypes";

type SortMode = "canvas" | "newest" | "oldest";

// ── Virtualization scaffolding ────────────────────────────────────────
// Ported from TagsView's useVirtualRows. Same behavior: per-row measured
// heights cached in a ref, binary-search to find the first visible row,
// configurable overscan, ResizeObserver tracks each row's true height so
// the layout self-corrects after Tiptap mounts inflate a card.
//
// CanvasFeed-specific addition: `mustRender` is a set of IDs that are
// always emitted into the virtual window, even when off-screen — used
// to pin the currently-editing card so the user doesn't lose their
// Tiptap state when scrolling.

const FEED_ROW_ESTIMATE = 140;
const FEED_ROW_GAP_COMFY = 10;
const FEED_ROW_GAP_COMPACT = 4;
const FEED_ROW_OVERSCAN = 8;

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

interface VirtualItem<T> {
  item: T;
  start: number;
}

function useVirtualRows<T extends { id: string }>(
  items: T[],
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  listRef: React.RefObject<HTMLDivElement | null>,
  layoutKey: string,
  mustRenderIds?: Set<string>,
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
      for (const observer of observersRef.current.values()) observer.disconnect();
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
      const size = sizeByIdRef.current.get(item.id) ?? FEED_ROW_ESTIMATE;
      sizes.push(size);
      totalSize += size;
    }
    return { offsets, sizes, totalSize };
  }, [items, sizeVersion]);

  const virtualItems = useMemo(() => {
    if (items.length === 0) return [] as VirtualItem<T>[];

    const overscanPx = FEED_ROW_ESTIMATE * FEED_ROW_OVERSCAN;
    const fromPx = Math.max(0, metrics.scrollTop - overscanPx);
    const toPx = Math.min(
      layout.totalSize,
      metrics.scrollTop + metrics.viewportHeight + overscanPx,
    );
    const startIndex = Math.max(
      0,
      findIndexAtOffset(layout.offsets, fromPx) - FEED_ROW_OVERSCAN,
    );
    const endIndex = Math.min(
      items.length - 1,
      findIndexAtOffset(layout.offsets, toPx) + FEED_ROW_OVERSCAN,
    );

    const out: VirtualItem<T>[] = [];
    for (let index = startIndex; index <= endIndex; index++) {
      out.push({ item: items[index], start: layout.offsets[index] });
    }

    // Pin any forced-render items (typically the editing card) so they
    // stay mounted regardless of scroll position. Append at their
    // natural offset; they'll render off-screen but keep their state.
    if (mustRenderIds && mustRenderIds.size > 0) {
      const have = new Set(out.map((v) => v.item.id));
      for (let i = 0; i < items.length; i++) {
        if (!mustRenderIds.has(items[i].id) || have.has(items[i].id)) continue;
        out.push({ item: items[i], start: layout.offsets[i] });
      }
    }
    return out;
  }, [items, layout, metrics, mustRenderIds]);

  const measureElement = useCallback(
    (id: string, el: HTMLDivElement | null) => {
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
    },
    [],
  );

  return { totalSize: layout.totalSize, virtualItems, measureElement };
}

/**
 * Serialize the editor's doc to markdown while preserving empty
 * paragraphs across the round-trip. Plain markdown has no syntax
 * for "an empty paragraph" — consecutive blank lines collapse — so
 * tiptap-markdown's default serializer drops them and the user
 * loses intentional whitespace on save. We walk the top-level doc
 * nodes ourselves: empty paragraphs become a single U+00A0 (NBSP)
 * line, everything else serializes normally. NBSP isn't whitespace
 * by CommonMark spec, so the paragraph survives markdown → PM and
 * the empty line reappears on reload.
 */
function getMarkdownPreservingEmptyParas(ed: Editor): string {
  const serializer = (ed.storage as any).markdown?.serializer;
  if (!serializer) {
    return (ed.storage as any).markdown?.getMarkdown?.() ?? "";
  }
  const parts: string[] = [];
  ed.state.doc.content.forEach((node) => {
    if (node.type.name === "paragraph" && node.textContent.length === 0) {
      parts.push(" ");
    } else {
      parts.push(serializer.serialize(node));
    }
  });
  return parts.join("\n\n");
}

function virtualRowStyle(start: number, gap: number): React.CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${start}px)`,
    paddingBottom: gap,
    boxSizing: "border-box",
  };
}

interface Props {
  /**
   * Search query whose matches should be highlighted inside read-only
   * cards. Empty string disables highlighting.
   */
  searchQuery?: string;
  /**
   * Block id of the currently-active search hit. Highlighted matches inside
   * that card render with a stronger color, mirroring the canvas's old
   * SearchHighlight "active" decoration.
   */
  activeSearchId?: string | null;
  /**
   * When set, the feed filters to only blocks that carry this tag —
   * subsumes the old separate TagsView. Null shows everything in canvas
   * order.
   */
  tagFilter?: string | null;
  /** Clear-handler for the tag filter chip up top. */
  onClearTagFilter?: () => void;
  /** Set the active tag filter. Used by the fullscreen editor to route
   *  a tag-chip click back up to App-level state. */
  onSelectTag?: (tag: string) => void;
  /** When set, narrow the feed to ONLY this single block (used by
   *  sidebar search-result clicks). */
  focusedBlockId?: string | null;
  /** Clear-handler for the focused-block chip up top. */
  onClearFocusedBlock?: () => void;
  /** Case-sensitive switch for both FTS and inline highlight. */
  caseSensitive?: boolean;
  /** Updated-at range filter. Either bound is exclusive of null
   *  (omitted side = unbounded). */
  dateRange?: { from: number | null; to: number | null };
  onClearDateRange?: () => void;
  /** Notified when the user enters / leaves the fullscreen single-block
   *  view. App uses this to adapt the ChatBox placeholder so the user
   *  knows captures still go to all blocks, not the expanded block. */
  onFullscreenChange?: (active: boolean) => void;
}

interface PendingFocus {
  id: string;
  edge: "start" | "end";
}

/**
 * Feed-shaped canvas. Each block is a self-contained card; only the
 * **focused** card mounts a Tiptap editor. Every other card is rendered
 * as static markdown HTML — meaning a 2k-block workspace has at most one
 * live ProseMirror instance at a time.
 *
 * This eliminates the per-keystroke O(N) work that the single-doc canvas
 * pays — `update()` calls on every block, `getPos` sibling walks, NodeView
 * portal reconciliation. The card list is memo'd per block reference,
 * so a typing-driven save invalidates only the edited card.
 */
export function CanvasFeed({
  searchQuery = "",
  activeSearchId,
  tagFilter = null,
  onClearTagFilter,
  onSelectTag,
  focusedBlockId = null,
  onClearFocusedBlock,
  caseSensitive = false,
  dateRange = { from: null, to: null },
  onClearDateRange,
  onFullscreenChange,
}: Props) {
  const blocks = useWorkspace((s) => s.blocks);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);
  const runWithUndo = useWorkspace((s) => s.runWithUndo);
  const compact = useUISettings((s) => s.compact);
  const hideHeaders = useUISettings((s) => s.hideHeaders);
  const setHideHeaders = useUISettings((s) => s.setHideHeaders);
  const rowGap = compact ? FEED_ROW_GAP_COMPACT : FEED_ROW_GAP_COMFY;

  const [pendingFocus, setPendingFocus] = useState<PendingFocus | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [historyBlockId, setHistoryBlockId] = useState<string | null>(null);
  const [sort, setSort] = useState<SortMode>("canvas");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // FTS hit-set scoped to `searchQuery`. When non-null, filters the visible
  // cards down to only those IDs (intersected with the tag filter). Mirrors
  // the old TagsView pattern.
  const [searchHitIds, setSearchHitIds] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  // Titles-only view: filter to blocks with a non-empty title and
  // render each as a compact one-line row. Toggled per session from
  // the toolbar; not persisted (cmd-toggle while browsing).
  const [titlesOnly, setTitlesOnly] = useState(false);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchHitIds(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = window.setTimeout(() => {
      ipc
        .search(q, 200, caseSensitive)
        .then((hits) => setSearchHitIds(new Set(hits.map((h) => h.id))))
        .catch(() => setSearchHitIds(new Set()))
        .finally(() => setSearching(false));
    }, 150);
    return () => window.clearTimeout(t);
  }, [searchQuery, caseSensitive]);

  // Canonical canvas-order list (all blocks, ignores filter / sort). Used
  // by structural ops that need to know about *every* block's position —
  // insert / append / re-parent / etc.
  const canvas = useMemo(
    () => [...blocks].sort((a, b) => a.position - b.position),
    [blocks],
  );
  // Visible list — what the feed actually renders. Filter narrows by tag;
  // search FTS narrows further; sort can override canvas order. A
  // focused-block id (from sidebar search-result click) takes precedence
  // over everything else and shows just that one card.
  const sorted = useMemo(() => {
    if (focusedBlockId) {
      const hit = canvas.find((b) => b.id === focusedBlockId);
      return hit ? [hit] : [];
    }
    let arr = canvas;
    if (tagFilter) {
      const needle = tagFilter.toLowerCase();
      arr = arr.filter((b) => b.tags.includes(needle));
    }
    if (searchHitIds) {
      arr = arr.filter((b) => searchHitIds.has(b.id));
    }
    if (dateRange.from != null || dateRange.to != null) {
      const from = dateRange.from ?? -Infinity;
      const to = dateRange.to ?? Infinity;
      arr = arr.filter((b) => b.updated_at >= from && b.updated_at < to);
    }
    if (titlesOnly) {
      arr = arr.filter((b) => (b.title ?? "").trim().length > 0);
    }
    if (sort === "newest")
      arr = [...arr].sort((a, b) => b.updated_at - a.updated_at);
    else if (sort === "oldest")
      arr = [...arr].sort((a, b) => a.updated_at - b.updated_at);
    // Pinned blocks float to the top, preserving the chosen sort
    // order within each partition. "Pinned" is scope-dependent: in
    // a tag filter view, a block counts as pinned if it carries
    // that tag in its scope set; in the All view, the empty-string
    // scope is the global pin.
    const currentScope = tagFilter ?? "";
    if (arr.length > 1) {
      const pinned = arr.filter((b) => b.pinned_scopes.includes(currentScope));
      const rest = arr.filter((b) => !b.pinned_scopes.includes(currentScope));
      arr = pinned.length > 0 ? [...pinned, ...rest] : arr;
    }
    return arr;
  }, [
    canvas,
    tagFilter,
    searchHitIds,
    sort,
    focusedBlockId,
    dateRange.from,
    dateRange.to,
    titlesOnly,
  ]);

  // Drop selections whose blocks are no longer visible (filter changed,
  // block deleted, etc.) so the bulk-action bar's count reflects reality.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visibleIds = new Set(sorted.map((b) => b.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [sorted]);
  const sortedRef = useRef(sorted);
  const canvasRef = useRef(canvas);
  useEffect(() => {
    sortedRef.current = sorted;
    canvasRef.current = canvas;
  }, [sorted, canvas]);

  // Reorder is allowed in canvas-sort mode regardless of tag filter; with
  // a filter we slot-swap (keep canvas positions, just reassign the
  // filtered IDs to those slots). Sort-by-time disables drag because the
  // user is browsing chronologically — reordering would be meaningless.
  const canReorder = sort === "canvas";
  const reorderMode: "renumber" | "slot-swap" = tagFilter
    ? "slot-swap"
    : "renumber";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragStart = (e: DragStartEvent) => {
    setActiveDragId(String(e.active.id));
  };

  const handleDragOver = (e: DragOverEvent) => {
    if (!e.over || e.active.id === e.over.id) {
      setDropTarget(null);
      return;
    }
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    const ids = sortedRef.current.map((b) => b.id);
    const activeIdx = ids.indexOf(activeId);
    const overIdx = ids.indexOf(overId);
    if (activeIdx < 0 || overIdx < 0) {
      setDropTarget(null);
      return;
    }
    // If the dragged card was above the over card, dropping lands it
    // AFTER the over card; if below, BEFORE. (Mirrors the natural
    // dnd-kit shift that the user already sees.)
    setDropTarget({
      id: overId,
      position: activeIdx < overIdx ? "after" : "before",
    });
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveDragId(null);
    setDropTarget(null);
    if (!canReorder) return;
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const draggedId = String(active.id);
    const overId = String(over.id);

    // Multi-drag: if the user grabbed one of the selected blocks AND
    // they have multiple cards selected, treat the whole selected set
    // as the moving group. The cards rearrange to land contiguously at
    // the drop position (preserving their relative order).
    const multi = selected.has(draggedId) && selected.size > 1;
    const ids = sorted.map((b) => b.id);

    let next: string[];
    if (multi) {
      const movingSet = new Set(selected);
      const movingIds = sorted
        .filter((b) => movingSet.has(b.id))
        .map((b) => b.id);
      const rest = ids.filter((id) => !movingSet.has(id));
      let to = rest.indexOf(overId);
      if (to < 0) {
        // Drop target was itself a selected (moving) block — fall
        // back to where that block sits in the full visible list.
        const overIdxFull = ids.indexOf(overId);
        if (overIdxFull < 0) return;
        // Pick the nearest non-moving anchor at or before the over.
        let anchor = -1;
        for (let i = overIdxFull; i >= 0; i--) {
          if (!movingSet.has(ids[i])) {
            anchor = rest.indexOf(ids[i]);
            break;
          }
        }
        to = anchor + 1;
      } else {
        // Drop placement: above the over if dragging upward, below
        // otherwise. Use the dragged card's prior position vs over to
        // disambiguate. Simpler heuristic: always insert AFTER the over.
        to += 1;
      }
      next = [...rest.slice(0, to), ...movingIds, ...rest.slice(to)];
    } else {
      const from = ids.indexOf(draggedId);
      const to = ids.indexOf(overId);
      if (from < 0 || to < 0) return;
      next = [...ids];
      next.splice(from, 1);
      next.splice(to, 0, draggedId);
    }

    await runWithUndo("Reorder", async () => {
      if (reorderMode === "slot-swap") {
        const slots = sorted
          .map((b) => b.position)
          .sort((a, b) => a - b);
        const updates: BlockInput[] = next.map((id, idx) => {
          const b = sorted.find((x) => x.id === id)!;
          return asBlockInput(b, { position: slots[idx] });
        });
        await saveSnapshot(updates, []);
        return;
      }
      const updates = recomputeParentIds(
        next.map((id, i) => {
          const b = sorted.find((x) => x.id === id)!;
          return asBlockInput(b, { position: i });
        }),
      );
      await saveSnapshot(updates, []);
    });
  };

  const insertBelow = async (afterId: string) => {
    // Insert relative to *canvas* order so the new block lands in a
    // sensible spot even when the visible list is filtered or sorted by
    // recency. Pre-tag the new block with the active tagFilter so it
    // immediately shows up in the filtered view.
    const all = canvasRef.current;
    const idx = all.findIndex((b) => b.id === afterId);
    if (idx < 0) return;
    const newId = ulid();
    const seedContent = tagFilter ? `#${tagFilter} ` : "";
    await runWithUndo("Add block", async () => {
      const updates: BlockInput[] = all.map((b, i) =>
        asBlockInput(b, { position: i <= idx ? i : i + 1 }),
      );
      updates.push({
        id: newId,
        content: seedContent,
        position: idx + 1,
        parent_id: all[idx]?.parent_id ?? null,
        heading: null,
        heading_level: null,
      });
      await saveSnapshot(recomputeParentIds(updates), []);
    });
    setPendingFocus({ id: newId, edge: "end" });
  };

  const appendNew = async () => {
    const all = canvasRef.current;
    const newId = ulid();
    const last = all[all.length - 1];
    const seedContent = tagFilter ? `#${tagFilter} ` : "";
    await runWithUndo("Add block", async () => {
      await saveSnapshot(
        [
          {
            id: newId,
            content: seedContent,
            position: (last?.position ?? -1) + 1,
            parent_id: last?.parent_id ?? null,
            heading: null,
            heading_level: null,
          },
        ],
        [],
      );
    });
    setPendingFocus({ id: newId, edge: "end" });
  };

  const deleteBlock = async (id: string) => {
    if (!window.confirm("Delete this block? (⌘Z undoes.)")) return;
    await runWithUndo("Delete", async () => {
      await saveSnapshot([], [id]);
    });
  };

  /**
   * Clone a block: keep all content/heading/level metadata, mint a
   * fresh ulid, slot it in immediately after the source's canvas
   * position. Renumber to compact positions and recompute parent_id
   * by heading nesting.
   */
  const duplicateBlock = async (id: string) => {
    const all = canvasRef.current;
    const idx = all.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const src = all[idx];
    const newId = ulid();
    await runWithUndo("Duplicate", async () => {
      const updates: BlockInput[] = all.map((b, i) =>
        asBlockInput(b, { position: i <= idx ? i : i + 1 }),
      );
      updates.push({
        id: newId,
        content: src.content,
        position: idx + 1,
        parent_id: src.parent_id,
        heading: src.heading,
        heading_level: src.heading_level,
      });
      await saveSnapshot(recomputeParentIds(updates), []);
    });
    setPendingFocus({ id: newId, edge: "end" });
  };

  /**
   * Split a block at the editor's current cursor position. The half
   * before the cursor stays in the original block (preserving its id +
   * version history); the half after lands in a fresh block immediately
   * below. Mirrors the keyboard shortcut handled by CrossBlockNav.
   */
  const splitBlockAtCursor = async (block: StoredBlock, editor: Editor) => {
    const md: string =
      (editor.storage as any).markdown?.getMarkdown?.() ?? block.content;
    const cleaned = unescapeInlineHashtags(md);
    // The PM selection position doesn't translate 1:1 to markdown offset
    // (PM has node-token positions; markdown is plain text). The
    // pragmatic proxy: serialize the doc fragment up to the cursor, use
    // that text length as the split point in the full markdown string.
    const beforeFragment = editor.state.doc.cut(0, editor.state.selection.from);
    const beforeMd: string = (editor.storage as any).markdown.serializer.serialize(beforeFragment);
    const beforeClean = unescapeInlineHashtags(beforeMd).trimEnd();
    const splitIdx = Math.min(beforeClean.length, cleaned.length);
    const left = cleaned.slice(0, splitIdx).trimEnd();
    const right = cleaned.slice(splitIdx).trimStart();
    // Cmd-Enter at the very end of a block still creates a fresh empty
    // block directly below (the user's mental model: "make a new block
    // here"). When there IS content after the cursor, the right half
    // lands in the new block. Either way, mint a successor.

    const all = canvasRef.current;
    const idx = all.findIndex((b) => b.id === block.id);
    if (idx < 0) return;
    const newId = ulid();
    // CRITICAL: update the source editor BEFORE we focus the new card.
    // Otherwise the FeedCard's sync-effect skips this card (still
    // focused), the focus moves to the new card, and the source editor
    // is left painting the original full content. The next render's
    // sync effect's dep array doesn't re-fire because block.content is
    // already "left." Explicit blur + setContent here pins it.
    editor.commands.setContent(left, { emitUpdate: false });
    editor.commands.blur();
    await runWithUndo("Split", async () => {
      const updates: BlockInput[] = all.map((b, i) =>
        asBlockInput(b, {
          content: b.id === block.id ? left : b.content,
          position: i <= idx ? i : i + 1,
        }),
      );
      updates.push({
        id: newId,
        content: right,
        position: idx + 1,
        parent_id: block.parent_id,
        heading: null,
        heading_level: null,
        // The new half inherits the source block's tag set, pin scopes,
        // and title so the split feels like "another piece of the same
        // thing" rather than a fresh untagged block.
        tags: block.tags,
        pinned_scopes: block.pinned_scopes,
        title: block.title ?? "",
      });
      await saveSnapshot(recomputeParentIds(updates), []);
    });
    setPendingFocus({ id: newId, edge: "start" });
  };

  /**
   * Merge-up handler triggered when the user presses Backspace at the very
   * start of a card. Behavior matches Notion / canvas-PM equivalents: if
   * the current block is empty, drop it and put the cursor at the end of
   * the previous block; if it has content, append it to the previous
   * block and remove the current one.
   */
  const mergeUp = async (currentId: string) => {
    const cur = sortedRef.current;
    const idx = cur.findIndex((b) => b.id === currentId);
    if (idx <= 0) return; // First block — nothing to merge into.
    const me = cur[idx];
    const prev = cur[idx - 1];
    await runWithUndo("Merge up", async () => {
      const mergedContent = me.content.trim().length
        ? `${prev.content}${prev.content && me.content ? "\n\n" : ""}${me.content}`
        : prev.content;
      await saveSnapshot(
        [asBlockInput(prev, { content: mergedContent })],
        [me.id],
      );
    });
    setPendingFocus({ id: prev.id, edge: "end" });
  };

  const focusNeighbor = (currentId: string, dir: 1 | -1) => {
    const cur = sortedRef.current;
    const idx = cur.findIndex((b) => b.id === currentId);
    if (idx < 0) return;
    const target = cur[idx + dir];
    if (!target) return;
    setPendingFocus({ id: target.id, edge: dir > 0 ? "start" : "end" });
  };

  const addTagToBlock = async (block: StoredBlock, raw: string) => {
    const t = raw.trim().toLowerCase().replace(/^#/, "");
    if (!/^[A-Za-z][A-Za-z0-9_\-/]*$/.test(t)) return;
    if (block.tags.includes(t)) return;
    await runWithUndo("Add tag", async () => {
      await saveSnapshot(
        [asBlockInput(block, { tags: [...block.tags, t] })],
        [],
      );
    });
  };

  const removeTagFromBlock = async (block: StoredBlock, tag: string) => {
    await runWithUndo("Remove tag", async () => {
      await saveSnapshot(
        [asBlockInput(block, { tags: block.tags.filter((t) => t !== tag) })],
        [],
      );
    });
  };

  const togglePin = async (block: StoredBlock) => {
    // Pin within the current view's scope: empty string = "All blocks",
    // otherwise the active tag name. Add or remove from the block's
    // scope set; the saved set is the full replacement.
    const scope = tagFilter ?? "";
    const has = block.pinned_scopes.includes(scope);
    const next = has
      ? block.pinned_scopes.filter((s) => s !== scope)
      : [...block.pinned_scopes, scope];
    await runWithUndo(has ? "Unpin" : "Pin", async () => {
      await saveSnapshot(
        [asBlockInput(block, { pinned_scopes: next })],
        [],
      );
    });
  };

  const setTitle = async (block: StoredBlock, raw: string) => {
    const t = raw.trim();
    if ((block.title ?? "") === t) return;
    await runWithUndo(t ? "Set title" : "Clear title", async () => {
      await saveSnapshot(
        [asBlockInput(block, { title: t })],
        [],
      );
    });
  };

  /**
   * Apply an editorless block-type transform — used when the user picks
   * "Turn into" on a non-mounted card. Mirrors what `BLOCK_TYPES[i].apply`
   * does inside the editor, but operates on raw markdown so we don't have
   * to round-trip through Tiptap just to swap a prefix.
   */
  const applyTurnInto = async (block: StoredBlock, typeId: string) => {
    const stripped = stripBlockPrefix(block.content);
    let newContent = stripped;
    let heading: string | null = null;
    let heading_level: number | null = null;
    switch (typeId) {
      case "h1":
        newContent = `# ${stripped}`;
        heading_level = 1;
        heading = stripped;
        break;
      case "h2":
        newContent = `## ${stripped}`;
        heading_level = 2;
        heading = stripped;
        break;
      case "h3":
        newContent = `### ${stripped}`;
        heading_level = 3;
        heading = stripped;
        break;
      case "bullet":
        newContent = `- ${stripped}`;
        break;
      case "numbered":
        newContent = `1. ${stripped}`;
        break;
      case "todo":
        newContent = `- [ ] ${stripped}`;
        break;
      case "quote":
        newContent = `> ${stripped}`;
        break;
      case "code":
        newContent = "```\n" + stripped + "\n```";
        break;
      default:
        newContent = stripped;
    }
    await runWithUndo("Turn into", async () => {
      await saveSnapshot(
        [asBlockInput(block, { content: newContent, heading, heading_level })],
        [],
      );
    });
  };

  // ── Bulk actions (multi-select) ────────────────────────────────────
  // All operate on the IDs in `selected` projected through `sorted` so the
  // user's visual order is preserved.

  const groupSelected = async () => {
    if (selected.size < 2) return;
    await runWithUndo("Group", async () => {
      const all = canvasRef.current;
      const selectedInOrder = sorted.filter((b) => selected.has(b.id));
      const ids = new Set(selectedInOrder.map((b) => b.id));
      const firstPos = Math.min(...selectedInOrder.map((b) => b.position));
      const before = all.filter((b) => b.position < firstPos && !ids.has(b.id));
      const after = all.filter((b) => b.position >= firstPos && !ids.has(b.id));
      const reordered = [...before, ...selectedInOrder, ...after];
      const updates = recomputeParentIds(
        reordered.map((b, i) => asBlockInput(b, { position: i })),
      );
      await saveSnapshot(updates, []);
    });
  };

  const mergeSelected = async () => {
    if (selected.size < 2) return;
    const selectedInOrder = sorted.filter((b) => selected.has(b.id));
    const keep = [...selectedInOrder].sort((a, b) => a.position - b.position)[0];
    const others = selectedInOrder.filter((b) => b.id !== keep.id);
    if (
      !window.confirm(
        `Merge ${selectedInOrder.length} blocks into one? The merged block lands at the canvas position of the earliest selected block.`,
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

  /**
   * Split each selected block by its top-level chunks — paragraphs, list
   * items, headings — into separate blocks. Fenced code blocks stay whole.
   * The original block keeps its ID and history (becomes the first chunk);
   * subsequent chunks are minted as fresh blocks immediately after.
   */
  const splitSelected = async () => {
    if (selected.size === 0) return;
    const willSplit = sorted.some(
      (b) =>
        selected.has(b.id) && splitContentIntoChunks(b.content).length > 1,
    );
    if (!willSplit) {
      window.alert("Nothing to split — selected blocks are already single chunks.");
      return;
    }
    await runWithUndo("Split", async () => {
      const all = canvasRef.current;
      const updates: BlockInput[] = [];
      let pos = 0;
      for (const b of all) {
        if (selected.has(b.id)) {
          const chunks = splitContentIntoChunks(b.content);
          if (chunks.length <= 1) {
            updates.push(asBlockInput(b, { position: pos++ }));
            continue;
          }
          updates.push(asBlockInput(b, { content: chunks[0], position: pos++ }));
          for (let i = 1; i < chunks.length; i++) {
            updates.push({
              id: ulid(),
              content: chunks[i],
              position: pos++,
              parent_id: b.parent_id,
              heading: null,
              heading_level: null,
              // Carry the source block's tags onto each split chunk — same
              // rationale as the cmd-enter split in splitBlockAtCursor.
              tags: b.tags,
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

  const exportSelected = async () => {
    if (selected.size === 0) return;
    const selectedInOrder = sorted.filter((b) => selected.has(b.id));
    // Tags now live in their own table — round-trip them back as a
    // trailing `#tag #tag` line per block so the exported markdown
    // stays readable and re-importable.
    const md = selectedInOrder
      .map((b) => {
        if (b.tags.length === 0) return b.content;
        const tagLine = b.tags.map((t) => `#${t}`).join(" ");
        return b.content ? `${b.content}\n\n${tagLine}` : tagLine;
      })
      .join("\n\n");
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

  const removeTagFromSelected = async () => {
    if (!tagFilter || selected.size === 0) return;
    await runWithUndo("Remove tag", async () => {
      const updates: BlockInput[] = sorted
        .filter((b) => selected.has(b.id) && b.tags.includes(tagFilter))
        .map((b) =>
          asBlockInput(b, {
            tags: b.tags.filter((t) => t !== tagFilter),
          }),
        );
      if (updates.length > 0) await saveSnapshot(updates, []);
    });
    setSelected(new Set());
  };

  const bulkAddTag = async (rawTag: string) => {
    const t = rawTag.trim().toLowerCase().replace(/^#/, "");
    if (!/^[A-Za-z][A-Za-z0-9_\-/]*$/.test(t)) return;
    if (selected.size === 0) return;
    await runWithUndo("Add tag", async () => {
      const updates: BlockInput[] = sorted
        .filter((b) => selected.has(b.id) && !b.tags.includes(t))
        .map((b) => asBlockInput(b, { tags: [...b.tags, t] }));
      if (updates.length > 0) await saveSnapshot(updates, []);
    });
  };

  const bulkRemoveTag = async (tag: string) => {
    if (selected.size === 0) return;
    await runWithUndo("Remove tag", async () => {
      const updates: BlockInput[] = sorted
        .filter((b) => selected.has(b.id) && b.tags.includes(tag))
        .map((b) =>
          asBlockInput(b, { tags: b.tags.filter((t) => t !== tag) }),
        );
      if (updates.length > 0) await saveSnapshot(updates, []);
    });
  };

  // Tags present on EVERY selected block — what bulk-remove can act on.
  const selectedTagIntersection = useMemo(() => {
    const sel = sorted.filter((b) => selected.has(b.id));
    if (sel.length === 0) return [] as string[];
    let inter = new Set(sel[0].tags);
    for (let i = 1; i < sel.length; i++) {
      const here = new Set(sel[i].tags);
      inter = new Set([...inter].filter((t) => here.has(t)));
    }
    return [...inter];
  }, [sorted, selected]);

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    if (
      !window.confirm(
        `Delete ${selected.size} block${selected.size === 1 ? "" : "s"}? (⌘Z undoes.)`,
      )
    )
      return;
    await runWithUndo("Delete", async () => {
      await saveSnapshot([], Array.from(selected));
    });
    setSelected(new Set());
  };

  // Tracks the most recent single-block click so shift-click can extend
  // a range from there to the current click target. Resets when the
  // visible list shape changes (filter/sort).
  const lastSelectedRef = useRef<string | null>(null);

  // When a selected card is being dragged AND more than one card is
  // selected, treat it as a multi-drag — fade out all selected siblings
  // visually so the user sees the whole group "lifting" together.
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const groupDragActive =
    activeDragId !== null && selected.has(activeDragId) && selected.size > 1;

  // Where the drop indicator line should land: above (`before`) or
  // below (`after`) a specific card. Computed in onDragOver by
  // comparing active vs over positions in the visible list.
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: "before" | "after";
  } | null>(null);

  const toggleSelect = useCallback(
    (id: string, shiftKey: boolean) => {
      if (shiftKey && lastSelectedRef.current) {
        const ids = sortedRef.current.map((b) => b.id);
        const from = ids.indexOf(lastSelectedRef.current);
        const to = ids.indexOf(id);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelected((prev) => {
            const next = new Set(prev);
            for (let i = lo; i <= hi; i++) next.add(ids[i]);
            return next;
          });
          lastSelectedRef.current = id;
          return;
        }
      }
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      lastSelectedRef.current = id;
    },
    [],
  );

  // Wire the BlockMenu's "Duplicate" and "History" actions. The menu
  // dispatches custom DOM events instead of taking callbacks because it
  // lives behind a portal — using events avoids prop-drilling through
  // an out-of-tree component.
  useEffect(() => {
    const onDup = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) void duplicateBlock(id);
    };
    const onHistory = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) setHistoryBlockId(id);
    };
    window.addEventListener("mochi-feed:duplicate", onDup);
    window.addEventListener("mochi:show-history", onHistory);
    return () => {
      window.removeEventListener("mochi-feed:duplicate", onDup);
      window.removeEventListener("mochi:show-history", onHistory);
    };
  }, []);

  const items = useMemo(() => sorted.map((b) => b.id), [sorted]);

  // ── Virtualization ────────────────────────────────────────────────
  // Render only the cards near the viewport; off-screen cards collapse
  // to a single positioned shell. React reconcile + paint stay bounded
  // by what's actually visible, not by the workspace size.
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A card that has a pending-focus pulse queued must stay rendered even
  // if it's outside the virtual window — otherwise the focus dispatch
  // races the mount and lands nowhere. Every other visible card already
  // mounts its own editor so they share state via the workspace store.
  const mustRender = useMemo(() => {
    const s = new Set<string>();
    if (pendingFocus) s.add(pendingFocus.id);
    return s;
  }, [pendingFocus]);

  const layoutKey = [
    tagFilter ?? "",
    sort,
    searchQuery,
    selected.size,
  ].join(":");
  const { totalSize, virtualItems, measureElement } = useVirtualRows(
    sorted,
    scrollRef,
    listRef,
    layoutKey,
    mustRender,
  );

  // Fullscreen single-block editor overlays the feed (rather than
  // replacing it via conditional return). The feed stays mounted and
  // its scroll position is preserved, so closing the fullscreen
  // lands the user right back where they were. Sidebar + top bar
  // still live one level up in App.tsx.
  const fullscreen = !!expandedId;
  useEffect(() => {
    onFullscreenChange?.(fullscreen);
  }, [fullscreen, onFullscreenChange]);
  return (
    <>
    <div
      className="flex-1 flex flex-col overflow-hidden"
      style={{ display: fullscreen ? "none" : "flex" }}
    /* `display: none` is added per-render; without changing the
        ref tree, the scrollRef + listRef remain attached to the
        SAME DOM nodes. When we toggle back, virtualization keeps
        working without a remount. */
    >
      {/* Sticky top toolbar — sort selector, filter chips, block count,
          and (when active) the bulk-action toolbar. Sits OUTSIDE the
          scroll container so it stays visible while you scroll the feed. */}
      <div className="px-6 pt-4 pb-2 border-b border-neutral-100 dark:border-neutral-800/60 shrink-0">
        <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-2 text-sm flex-wrap">
          {focusedBlockId && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200">
              <span className="font-medium">viewing 1 block</span>
              <button
                onClick={onClearFocusedBlock}
                title="Back to feed"
                className="text-amber-500 hover:text-amber-900 dark:hover:text-amber-100 leading-none"
              >
                ×
              </button>
            </span>
          )}
          {tagFilter && !focusedBlockId && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200">
              <span className="font-medium">#{tagFilter}</span>
              <button
                onClick={onClearTagFilter}
                title="Clear filter"
                className="text-blue-500 hover:text-blue-900 dark:hover:text-blue-100 leading-none"
              >
                ×
              </button>
            </span>
          )}
          {(dateRange.from != null || dateRange.to != null) && !focusedBlockId && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200">
              <span className="font-medium">
                {formatDateRange(dateRange.from, dateRange.to)}
              </span>
              <button
                onClick={onClearDateRange}
                title="Clear date range"
                className="text-purple-500 hover:text-purple-900 dark:hover:text-purple-100 leading-none"
              >
                ×
              </button>
            </span>
          )}
          <span className="text-neutral-500">
            {searching
              ? "searching…"
              : `${sorted.length} block${sorted.length === 1 ? "" : "s"}`}
          </span>
          <button
            onClick={() => setTitlesOnly((v) => !v)}
            title={titlesOnly ? "Show full blocks" : "Show only blocks with titles"}
            className={`ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${
              titlesOnly
                ? "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                : "border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            {titlesOnly ? "Titles only" : "All blocks"}
          </button>
          <button
            onClick={() => void setHideHeaders(!hideHeaders)}
            title={hideHeaders ? "Show block headers" : "Hide block headers (todo-list look)"}
            className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border ${
              hideHeaders
                ? "border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                : "border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            {hideHeaders ? "List view" : "Card view"}
          </button>
          <div className="mochi-sort-toggle inline-flex items-center rounded border border-neutral-200 dark:border-neutral-800 overflow-hidden text-xs">
            {(["canvas", "newest", "oldest"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setSort(m)}
                className={`px-2 py-1 ${
                  sort === m
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Bulk-action toolbar — slides in when the user has selected
            two or more cards via the per-card checkbox. */}
        {selected.size > 0 && (
          <div className="flex items-center gap-2 mt-2 px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-900/20 text-sm flex-wrap">
            <span className="text-blue-900 dark:text-blue-200">
              {selected.size} selected
            </span>
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-blue-700 dark:text-blue-300 hover:underline"
            >
              clear
            </button>
            <button
              onClick={() => setSelected(new Set(sorted.map((b) => b.id)))}
              disabled={selected.size === sorted.length}
              title="Select every visible block"
              className="inline-flex items-center gap-1 text-xs text-blue-700 dark:text-blue-300 hover:underline disabled:opacity-50 disabled:no-underline"
            >
              <CheckSquare size={12} /> select all ({sorted.length})
            </button>
            <div className="ml-auto flex items-center gap-2 flex-wrap">
              <ToolbarBtn
                onClick={groupSelected}
                disabled={selected.size < 2}
                title="Move selected blocks to be contiguous on the canvas"
                icon={<AlignVerticalSpaceAround size={13} />}
              >
                Group
              </ToolbarBtn>
              <ToolbarBtn
                onClick={mergeSelected}
                disabled={selected.size < 2}
                title="Combine selected blocks into one"
                icon={<Combine size={13} />}
              >
                Merge
              </ToolbarBtn>
              <ToolbarBtn
                onClick={splitSelected}
                title="Split each selected block by its top-level chunks"
                icon={<SplitSquareVertical size={13} />}
              >
                Split
              </ToolbarBtn>
              <ToolbarBtn
                onClick={exportSelected}
                title="Export selected blocks as a markdown file"
                icon={<Download size={13} />}
              >
                Export .md
              </ToolbarBtn>
              <BulkTagButton
                label="Add tag"
                excludeIntersection
                tagCandidates={selectedTagIntersection}
                onPick={(t) => void bulkAddTag(t)}
              />
              <BulkTagButton
                label="Remove tag"
                mode="remove"
                tagCandidates={selectedTagIntersection}
                onPick={(t) => void bulkRemoveTag(t)}
              />
              {tagFilter && (
                <ToolbarBtn
                  onClick={removeTagFromSelected}
                  title={`Strip #${tagFilter} from each selected block`}
                  icon={<X size={13} />}
                  tone="warn"
                >
                  Remove #{tagFilter}
                </ToolbarBtn>
              )}
              <ToolbarBtn
                onClick={deleteSelected}
                title="Delete selected blocks"
                icon={<Trash2 size={13} />}
                tone="danger"
              >
                Delete
              </ToolbarBtn>
            </div>
          </div>
        )}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pt-4 pb-32 cursor-text"
      >
        <div className="max-w-3xl mx-auto">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={() => {
            setActiveDragId(null);
            setDropTarget(null);
          }}
        >
          <SortableContext items={items} strategy={verticalListSortingStrategy}>
            <div
              ref={listRef}
              style={{ height: totalSize, position: "relative" }}
            >
            {virtualItems.map(({ item: b, start }) => (
              <div
                key={b.id}
                ref={(el) => measureElement(b.id, el)}
                style={virtualRowStyle(start, rowGap)}
              >
              {titlesOnly ? (
                <TitleRow block={b} onExpand={() => setExpandedId(b.id)} />
              ) : (
              <FeedCard
                block={b}
                scope={tagFilter ?? ""}
                pendingFocus={
                  pendingFocus?.id === b.id ? pendingFocus.edge : null
                }
                selected={selected.has(b.id)}
                groupDragGhost={groupDragActive && selected.has(b.id) && b.id !== activeDragId}
                dropIndicator={
                  dropTarget?.id === b.id ? dropTarget.position : null
                }
                highlightQuery={searchQuery}
                highlightCaseSensitive={caseSensitive}
                isActiveSearchHit={activeSearchId === b.id}
                onAutoFocused={() => setPendingFocus(null)}
                onInsertBelow={() => insertBelow(b.id)}
                onDelete={() => deleteBlock(b.id)}
                onMergeUp={() => mergeUp(b.id)}
                onFocusNeighbor={(dir) => focusNeighbor(b.id, dir)}
                onTurnInto={(typeId) => applyTurnInto(b, typeId)}
                onAddTag={(t) => addTagToBlock(b, t)}
                onRemoveTag={(t) => removeTagFromBlock(b, t)}
                onToggleSelect={(shiftKey) => toggleSelect(b.id, shiftKey)}
                onTogglePin={() => togglePin(b)}
                onSetTitle={(t) => setTitle(b, t)}
                onExpand={() => setExpandedId(b.id)}
                onSplitAtCursor={(ed) => splitBlockAtCursor(b, ed)}
              />
              )}
              </div>
            ))}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={null}>
            {groupDragActive ? (
              <div className="px-3 py-1.5 rounded-md bg-blue-600 text-white text-xs font-medium shadow-lg">
                Moving {selected.size} blocks
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        <div className="mt-3">
          <button
            onClick={appendNew}
            className="w-full text-sm px-3 py-2 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-500 hover:text-neutral-800 hover:border-neutral-400 dark:hover:border-neutral-500"
          >
            + Add block
          </button>
        </div>
        </div>
      </div>

      {historyBlockId && (
        <VersionHistoryModal
          blockId={historyBlockId}
          onClose={() => setHistoryBlockId(null)}
        />
      )}
    </div>
    {fullscreen && expandedId && (
      <ExpandedBlockEditor
        blockId={expandedId}
        onClose={() => setExpandedId(null)}
        onSelectTag={(t) => {
          // Tag clicks in fullscreen drop the user back into the feed
          // already filtered by the chosen tag. Close first so the
          // App-level state update lands on a remounted feed.
          setExpandedId(null);
          onSelectTag?.(t);
        }}
      />
    )}
    </>
  );
}

interface CardProps {
  block: StoredBlock;
  /** Currently active pin scope: tagFilter or "" for global. The
   *  card's pin button toggles membership in this scope. */
  scope: string;
  pendingFocus: "start" | "end" | null;
  selected: boolean;
  /** True when this card is one of the SELECTED siblings of an
   *  in-progress group drag (but not the active card being dragged
   *  itself). Used to fade the card visually so the group reads as
   *  "lifting together." */
  groupDragGhost: boolean;
  /** Where to draw a drop-indicator line — above or below this card —
   *  during an active drag. Null when this isn't the current drop
   *  target. */
  dropIndicator: "before" | "after" | null;
  highlightQuery: string;
  highlightCaseSensitive: boolean;
  isActiveSearchHit: boolean;
  onAutoFocused: () => void;
  onInsertBelow: () => void;
  onDelete: () => void;
  onMergeUp: () => void;
  onFocusNeighbor: (dir: 1 | -1) => void;
  onTurnInto: (typeId: string) => void;
  onAddTag: (tag: string) => void;
  onRemoveTag: (tag: string) => void;
  onToggleSelect: (shiftKey: boolean) => void;
  onTogglePin: () => void;
  onSetTitle: (title: string) => void;
  onExpand: () => void;
  onSplitAtCursor: (editor: Editor) => void;
}

const FeedCard = memo(
  function FeedCard({
    block,
    scope,
    pendingFocus,
    selected,
    groupDragGhost,
    dropIndicator,
    highlightQuery,
    highlightCaseSensitive,
    isActiveSearchHit,
    onAutoFocused,
    onInsertBelow,
    onDelete,
    onMergeUp,
    onFocusNeighbor,
    onTurnInto,
    onAddTag,
    onRemoveTag,
    onToggleSelect,
    onTogglePin,
    onSetTitle,
    onExpand,
    onSplitAtCursor,
  }: CardProps) {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id: block.id });

    const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);
    // The 3-dot menu needs a live Tiptap editor for "turn into" operations
    // that depend on PM commands (lists, code blocks). The card lifts its
    // editor instance up via this ref so BlockMenu sees it.
    const [liveEditor, setLiveEditor] = useState<Editor | null>(null);

    const style: React.CSSProperties = {
      transform: DndCSS.Transform.toString(transform),
      transition,
      // Selected-but-not-actively-dragged cards in a group drag fade
      // so the group reads as moving together. The actively-dragged
      // card uses dnd-kit's standard isDragging opacity.
      opacity: isDragging ? 0.5 : groupDragGhost ? 0.35 : 1,
    };

    const headingLevel = block.heading_level;

    const openMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
      // Editor is always mounted now, so no edit-mode promotion needed —
      // just anchor the menu off the button rect. Stopping propagation
      // keeps the global mousedown listener inside BlockMenu from
      // immediately interpreting this same click as "outside, close".
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      setMenuAnchor(rect);
    };

    // Auto-collapse very long blocks at rest. Line-count proxy avoids
    // a per-card ResizeObserver; trips around ~10 lines or 700 chars.
    // The editor focus event lifts the collapse so typing always sees
    // the full block.
    const isLong = useMemo(() => {
      const lines = block.content.split("\n").length;
      return lines > 12 || block.content.length > 700;
    }, [block.content]);
    const [userExpanded, setUserExpanded] = useState(false);
    const [editorFocused, setEditorFocused] = useState(false);
    useEffect(() => {
      if (!liveEditor) return;
      const onFocus = () => setEditorFocused(true);
      const onBlur = () => setEditorFocused(false);
      liveEditor.on("focus", onFocus);
      liveEditor.on("blur", onBlur);
      setEditorFocused(liveEditor.isFocused);
      return () => {
        liveEditor.off("focus", onFocus);
        liveEditor.off("blur", onBlur);
      };
    }, [liveEditor]);
    const collapsed = isLong && !userExpanded && !editorFocused;

    const blockTypeId = (() => {
      const first = block.content.split("\n")[0] ?? "";
      const head = first.match(/^(#{1,6}) /);
      if (head) {
        const lvl = head[1].length;
        if (lvl >= 1 && lvl <= 3) return `h${lvl}`;
        return "paragraph";
      }
      if (/^\s*[-*+]\s+\[[ x]\]\s/.test(first)) return "todo";
      if (/^\s*[-*+]\s+/.test(first)) return "bullet";
      if (/^\s*\d+\.\s+/.test(first)) return "numbered";
      if (first.startsWith(">")) return "quote";
      if (first.startsWith("```")) return "code";
      return "paragraph";
    })();

    return (
      <article
        ref={setNodeRef}
        style={style}
        data-block-id={block.id}
        data-heading-level={headingLevel ?? undefined}
        className={`mochi-block-card group relative ${
          isActiveSearchHit
            ? "ring-2 ring-amber-300 dark:ring-amber-500"
            : selected
              ? "ring-2 ring-blue-300 dark:ring-blue-600"
              : ""
        }`}
      >
        {/* Drop-indicator line — shown above or below the card while a
            drag hovers over it, mirroring the natural shift dnd-kit
            performs but with an explicit visual bar. */}
        {dropIndicator && (
          <div
            aria-hidden
            className={`absolute inset-x-0 ${
              dropIndicator === "before" ? "-top-1.5" : "-bottom-1.5"
            } h-1 bg-blue-500 rounded-full z-20 pointer-events-none`}
          />
        )}
        {/* Always-visible top bar. Left: checkbox + tag chips. Right:
            insert / expand / more / drag (drag right-most so it's a
            consistent anchor point). */}
        <div
          contentEditable={false}
          className="mochi-card-header flex items-center gap-2 px-3 pt-2 pb-1 border-b border-neutral-100 dark:border-neutral-800/60"
        >
          <input
            type="checkbox"
            checked={selected}
            readOnly
            onClick={(e) => {
              e.stopPropagation();
              onToggleSelect(e.shiftKey);
            }}
            className="cursor-pointer shrink-0"
            title="Select (shift-click to range-select)"
          />
          <BlockTitleField title={block.title} onCommit={onSetTitle} />
          <TagChipStrip
            tags={block.tags}
            showAdder
            onAdd={onAddTag}
            onRemove={onRemoveTag}
          />
          <span
            className="text-[11px] text-neutral-400 shrink-0 tabular-nums"
            title={new Date(block.updated_at).toLocaleString()}
          >
            {relativeTime(block.updated_at)}
          </span>
          <div className="flex items-center gap-0.5 text-neutral-400 shrink-0">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              title={
                block.pinned_scopes.includes(scope)
                  ? scope
                    ? `Unpin from #${scope}`
                    : "Unpin from top"
                  : scope
                    ? `Pin to top of #${scope}`
                    : "Pin to top"
              }
              className={`p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                block.pinned_scopes.includes(scope)
                  ? "text-blue-600 dark:text-blue-400"
                  : "hover:text-neutral-700 dark:hover:text-neutral-200"
              }`}
            >
              <Pin
                size={13}
                fill={block.pinned_scopes.includes(scope) ? "currentColor" : "none"}
              />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onInsertBelow}
              title="Add block below"
              className="p-1 rounded hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <Plus size={14} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onExpand}
              title="Open in full editor"
              className="p-1 rounded hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <Maximize2 size={13} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              title="Delete block"
              className="p-1 rounded text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
            >
              <Trash2 size={13} />
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={openMenu}
              title="More actions"
              className="p-1 rounded hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <MoreHorizontal size={14} />
            </button>
            <button
              type="button"
              {...attributes}
              {...listeners}
              title="Drag to reorder"
              className="p-1 rounded hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-grab active:cursor-grabbing"
            >
              <GripVertical size={14} />
            </button>
          </div>
        </div>

        {/* Body — editor always mounted. Single click positions cursor
            naturally because the contenteditable surface is already
            there; no read-only-to-editor flip, no layout shift. Long
            blocks collapse to ~280px until clicked into or expanded
            via the "Show more" button below. */}
        <div
          className={`px-4 pt-2 pb-3 relative ${
            collapsed ? "max-h-[280px] overflow-hidden" : ""
          }`}
        >
          <EditableBody
            block={block}
            pendingFocus={pendingFocus}
            highlightQuery={highlightQuery}
            highlightCaseSensitive={highlightCaseSensitive}
            isActiveSearchHit={isActiveSearchHit}
            onAutoFocused={onAutoFocused}
            onMergeUp={onMergeUp}
            onFocusNeighbor={onFocusNeighbor}
            onAppendBelow={onInsertBelow}
            onSplitHere={() => {
              // Cmd-Enter: split this block at the cursor. The live
              // editor is captured by the EditableBody itself, so this
              // closure just signals "do the split"; the parent picks
              // it up via `onSplitAtCursor` and forwards the editor.
              if (liveEditor) onSplitAtCursor(liveEditor);
            }}
            onEditorReady={setLiveEditor}
          />
          {collapsed && (
            <div
              contentEditable={false}
              className="absolute inset-x-0 bottom-0 h-20 flex items-end justify-center pb-2 pointer-events-none bg-gradient-to-t from-white dark:from-neutral-900 via-white/80 dark:via-neutral-900/80 to-transparent"
            >
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  setUserExpanded(true);
                }}
                className="pointer-events-auto text-xs px-2.5 py-1 rounded-full border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-600 dark:text-neutral-300 hover:border-neutral-400 dark:hover:border-neutral-500 shadow-sm"
              >
                Show more ▾
              </button>
            </div>
          )}
        </div>
        {isLong && userExpanded && !editorFocused && (
          <div
            contentEditable={false}
            className="flex justify-center pb-2 -mt-1"
          >
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                setUserExpanded(false);
              }}
              className="text-xs px-2.5 py-0.5 rounded-full text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              Show less ▴
            </button>
          </div>
        )}

        {menuAnchor &&
          createPortal(
            <BlockMenu
              block={block}
              editor={liveEditor}
              isFirst={false}
              anchorRect={menuAnchor}
              canSplitIntoBlocks={false}
              activeBlockTypeId={blockTypeId}
              onClose={() => setMenuAnchor(null)}
            onDelete={() => {
              setMenuAnchor(null);
              onDelete();
            }}
            onDuplicate={() => {
              setMenuAnchor(null);
              window.dispatchEvent(
                new CustomEvent("mochi-feed:duplicate", {
                  detail: { id: block.id },
                }),
              );
            }}
            onTurnInto={(typeId) => {
              setMenuAnchor(null);
              // Prefer in-editor command when we have one — it preserves the
              // user's selection/cursor; otherwise fall back to the markdown
              // rewrite path on the parent.
              if (liveEditor) {
                const def = BLOCK_TYPES.find((b) => b.id === typeId);
                if (def) {
                  def.apply(liveEditor);
                  return;
                }
              }
              onTurnInto(typeId);
            }}
            onMergeUp={() => {
              setMenuAnchor(null);
              onMergeUp();
            }}
            onShowHistory={() => {
              setMenuAnchor(null);
              window.dispatchEvent(
                new CustomEvent("mochi:show-history", {
                  detail: { id: block.id },
                }),
              );
            }}
            onCopyMarkdown={() => {
              setMenuAnchor(null);
              void navigator.clipboard.writeText(block.content);
            }}
            onCopyId={() => {
              setMenuAnchor(null);
              void navigator.clipboard.writeText(block.id);
            }}
              onSplitIntoBlocks={() => setMenuAnchor(null) /* deferred */}
              onSplitAtCursor={() => {
                setMenuAnchor(null);
                if (liveEditor) void onSplitAtCursor(liveEditor);
              }}
            />,
            document.body,
          )}
      </article>
    );
  },
  (prev, next) =>
    prev.block === next.block &&
    prev.scope === next.scope &&
    prev.pendingFocus === next.pendingFocus &&
    prev.selected === next.selected &&
    prev.groupDragGhost === next.groupDragGhost &&
    prev.dropIndicator === next.dropIndicator &&
    prev.highlightQuery === next.highlightQuery &&
    prev.highlightCaseSensitive === next.highlightCaseSensitive &&
    prev.isActiveSearchHit === next.isActiveSearchHit,
);

/**
 * Compact one-line row for the titles-only view. Click opens the
 * full editor in fullscreen so the user can read or edit the body.
 */
function TitleRow({
  block,
  onExpand,
}: {
  block: StoredBlock;
  onExpand: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full text-left px-3 py-1.5 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-800 flex items-center gap-2"
    >
      <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate flex-1">
        {block.title ?? "Untitled"}
      </span>
      {block.tags.slice(0, 3).map((t) => (
        <span
          key={t}
          className="px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-[10px] font-medium shrink-0"
        >
          #{t}
        </span>
      ))}
      <span className="text-[11px] text-neutral-400 shrink-0 tabular-nums">
        {relativeTime(block.updated_at)}
      </span>
    </button>
  );
}

/**
 * Editable title field for a block. Renders as an unstyled inline
 * input — placeholder is "Untitled" when the value is empty. Commits
 * on blur or Enter; Escape reverts to the last persisted title.
 */
function BlockTitleField({
  title,
  onCommit,
}: {
  title: string | null;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string>(title ?? "");
  useEffect(() => {
    setDraft(title ?? "");
  }, [title]);
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => {
        if (draft !== (title ?? "")) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(title ?? "");
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="Untitled"
      className="shrink-0 min-w-0 w-32 max-w-[14rem] bg-transparent outline-none border-b border-transparent focus:border-neutral-300 dark:focus:border-neutral-700 text-xs font-medium text-neutral-700 dark:text-neutral-200 placeholder:text-neutral-400 placeholder:italic placeholder:font-normal"
      title={title ? `Title: ${title}` : "Set a title for this block"}
    />
  );
}

function EditableBody({
  block,
  pendingFocus,
  highlightQuery,
  highlightCaseSensitive,
  isActiveSearchHit,
  onAutoFocused,
  onMergeUp,
  onFocusNeighbor,
  onAppendBelow,
  onSplitHere,
  onEditorReady,
}: {
  block: StoredBlock;
  pendingFocus: "start" | "end" | null;
  highlightQuery: string;
  highlightCaseSensitive: boolean;
  isActiveSearchHit: boolean;
  onAutoFocused: () => void;
  onMergeUp: () => void;
  onFocusNeighbor: (dir: 1 | -1) => void;
  onAppendBelow: () => void;
  onSplitHere: () => void;
  onEditorReady: (editor: Editor | null) => void;
}) {
  const tags = useWorkspace((s) => s.tags);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);
  const runWithUndoStore = useWorkspace((s) => s.runWithUndo);
  const tagsRef = useRef(tags);
  useEffect(() => {
    tagsRef.current = tags;
  }, [tags]);

  const blockRef = useRef(block);
  useEffect(() => {
    blockRef.current = block;
  }, [block]);
  const saveSnapshotRef = useRef(saveSnapshot);
  useEffect(() => {
    saveSnapshotRef.current = saveSnapshot;
  }, [saveSnapshot]);
  const runWithUndoRef = useRef(runWithUndoStore);
  useEffect(() => {
    runWithUndoRef.current = runWithUndoStore;
  }, [runWithUndoStore]);
  // True iff the most recent doc change for this editor was a hashtag
  // lift. While true, in-editor Cmd-Z removes the lifted chip via the
  // workspace undo stack instead of running Tiptap's text undo. Any
  // non-lift content change clears the flag, so subsequent Cmd-Z
  // returns to normal text-undo behavior.
  const lastActionWasLiftRef = useRef(false);

  const onMergeUpRef = useRef(onMergeUp);
  const onFocusNeighborRef = useRef(onFocusNeighbor);
  const onAppendBelowRef = useRef(onAppendBelow);
  const onSplitHereRef = useRef(onSplitHere);
  useEffect(() => {
    onMergeUpRef.current = onMergeUp;
    onFocusNeighborRef.current = onFocusNeighbor;
    onAppendBelowRef.current = onAppendBelow;
    onSplitHereRef.current = onSplitHere;
  }, [onMergeUp, onFocusNeighbor, onAppendBelow, onSplitHere]);

  const saveDebounced = useMemo(
    () =>
      debounce((md: string) => {
        const b = blockRef.current;
        const cleaned = unescapeInlineHashtags(md);
        if (cleaned === b.content) return;
        const { heading, level } = deriveHeading(cleaned);
        void saveSnapshotRef.current(
          [
            {
              id: b.id,
              content: cleaned,
              position: b.position,
              parent_id: b.parent_id,
              heading,
              heading_level: level,
            },
          ],
          [],
        );
      }, 300),
    [],
  );

  // Pull `#tag<terminator>` patterns out of the editor and into the
  // block's tags field — same chip-lift UX as ChatBox, kept in sync
  // here so the user sees the hashtag disappear the moment they type
  // space / comma / newline after it. Returns the list of newly
  // lifted tag names (lowercased, deduped against existing).
  const liftHashtagsFromEditor = (ed: Editor, existingTags: string[]): string[] => {
    const { doc, selection } = ed.state;
    const cursorPos = selection.head;
    const ranges: { from: number; to: number; tag: string }[] = [];
    doc.descendants((node, pos, parent) => {
      if (!node.isText || !node.text) return;
      if (
        parent &&
        (parent.type.name === "codeBlock" || parent.type.name === "code")
      ) {
        return;
      }
      if (node.marks.some((m) => m.type.name === "code")) return;
      const re = /(^|[\s])#([A-Za-z][A-Za-z0-9_\-/]*)([\s,])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(node.text)) !== null) {
        const hashAt = pos + m.index + m[1].length;
        const tagEnd = hashAt + 1 + m[2].length;
        // Don't lift while the cursor is still inside the tag token.
        if (cursorPos > hashAt && cursorPos <= tagEnd) continue;
        ranges.push({ from: hashAt, to: tagEnd + 1, tag: m[2].toLowerCase() });
      }
    });
    if (ranges.length === 0) return [];
    const existingSet = new Set(existingTags);
    const lifted: string[] = [];
    for (const r of ranges) {
      if (!existingSet.has(r.tag) && !lifted.includes(r.tag)) lifted.push(r.tag);
    }
    // Apply deletions in reverse so earlier positions stay valid.
    // `addToHistory: false` keeps the strip out of Tiptap's local
    // undo stack — otherwise Cmd-Z would reverse just the PM delete
    // and the next onUpdate would re-lift the tag, looping. The
    // strip is registered on the workspace undo stack instead (see
    // the runWithUndo wrap in onUpdate); Cmd-Z inside the editor
    // falls through to the user's previous typing step.
    ranges.sort((a, b) => b.from - a.from);
    let tr = ed.state.tr;
    for (const r of ranges) tr = tr.delete(r.from, r.to);
    tr = tr.setMeta("addToHistory", false);
    ed.view.dispatch(tr);
    return lifted;
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: "mochi-link" },
        },
      }),
      UnderlineExtension,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, linkify: true, breaks: false }),
      Placeholder.configure({
        placeholder: "Type / for commands, # for heading…",
        showOnlyWhenEditable: true,
      }),
      Hashtag.configure({
        getTags: () => tagsRef.current.map((t) => t.tag),
      }),
      SearchHighlightPerCard,
      SlashMenu,
      CrossBlockNav.configure({
        onAppendBelow: () => onAppendBelowRef.current(),
        onMergeUp: () => onMergeUpRef.current(),
        onFocusNext: () => onFocusNeighborRef.current(1),
        onFocusPrev: () => onFocusNeighborRef.current(-1),
        onSplitHere: () => onSplitHereRef.current(),
      }),
    ],
    content: block.content,
    // No `autofocus` — the editor mounts on every visible card now, so
    // letting Tiptap auto-grab focus would dump the cursor into the
    // first-rendered card. Focus is delivered explicitly via the
    // pendingFocus dispatch below when a structural action wants it.
    autofocus: false,
    editorProps: {
      handleKeyDown(_view, event) {
        // Intercept Mod-Z when the most recent action was a hashtag
        // lift — pop that lift off the workspace undo stack instead
        // of running Tiptap's text undo. The lifted hashtag text is
        // NOT restored to the editor body (avoids a re-lift loop on
        // the next keystroke); only the chip is removed.
        const mod = event.metaKey || event.ctrlKey;
        if (
          mod &&
          event.key.toLowerCase() === "z" &&
          !event.shiftKey &&
          lastActionWasLiftRef.current
        ) {
          event.preventDefault();
          lastActionWasLiftRef.current = false;
          // Cancel any in-flight debounced save first — undoLast
          // restores prior state directly; we don't want a stale
          // post-undo save clobbering it.
          saveDebounced.cancel();
          void useWorkspace.getState().undoLast();
          return true;
        }
        // Backspace parity with the ChatBox: when the immediately-
        // previous edit was a hashtag lift, the user's mental model
        // is "I just made a tag, that backspace undoes it." The
        // lift-undo flag only stays true until any non-lift edit
        // happens, so this won't fire mid-typing.
        if (event.key === "Backspace" && lastActionWasLiftRef.current) {
          event.preventDefault();
          lastActionWasLiftRef.current = false;
          saveDebounced.cancel();
          void useWorkspace.getState().undoLast();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      // Lift any `#tag<space|comma|newline>` out of the body into the
      // block's tags field. Dispatches its own PM transaction (delete
      // the token range) so the visible text strips immediately. When
      // a lift happens, fire an authoritative save right away with
      // the merged tag set — the debounced path would race with the
      // next keystroke and could re-introduce the tag from prior state.
      const b = blockRef.current;
      const lifted = liftHashtagsFromEditor(editor, b.tags);
      if (lifted.length > 0) {
        saveDebounced.cancel();
        const md = getMarkdownPreservingEmptyParas(editor);
        const cleaned = unescapeInlineHashtags(md);
        const { heading, level } = deriveHeading(cleaned);
        const label = lifted.length === 1 ? `Lift #${lifted[0]}` : "Lift tags";
        void runWithUndoRef.current(label, async () => {
          await saveSnapshotRef.current(
            [
              {
                id: b.id,
                content: cleaned,
                position: b.position,
                parent_id: b.parent_id,
                heading,
                heading_level: level,
                tags: [...b.tags, ...lifted],
              },
            ],
            [],
          );
        });
        lastActionWasLiftRef.current = true;
        return;
      }
      // Any non-lift content change clears the lift-undo flag, so
      // the next Cmd-Z falls through to normal text undo.
      lastActionWasLiftRef.current = false;
      // Don't fire debounced saves while the user is mid-tag (cursor
      // inside an in-progress `#tag` range with no terminator yet) —
      // otherwise a 300ms pause after `#q` would commit `q` as a tag.
      if (cursorInsideHashtag(editor)) {
        saveDebounced.cancel();
        return;
      }
      const md = getMarkdownPreservingEmptyParas(editor);
      saveDebounced(md);
    },
    onSelectionUpdate: ({ editor }) => {
      // Pair to onUpdate above: doc-changes-only would miss the
      // "user moved cursor out of a tag without typing more"
      // case (arrow keys, mouse click). When that happens, fire a
      // save with the current content so deferred typing lands.
      if (cursorInsideHashtag(editor)) return;
      const md = getMarkdownPreservingEmptyParas(editor);
      saveDebounced(md);
    },
    onBlur: ({ editor }) => {
      // Blur is the user committing — flush any pending save, AND
      // force a save with the current content (in case we were
      // skipping due to cursor-in-tag).
      saveDebounced.flush();
      const md = getMarkdownPreservingEmptyParas(editor);
      saveDebounced(md);
      saveDebounced.flush();
    },
  });

  // Pump search-query updates into the editor's SearchHighlightPerCard
  // plugin via setMeta. Avoids re-creating the editor when the query
  // changes — just a transaction that rebuilds the decoration set.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(searchHighlightKey, {
        query: highlightQuery,
        active: isActiveSearchHit,
        caseSensitive: highlightCaseSensitive,
      }),
    );
  }, [editor, highlightQuery, isActiveSearchHit, highlightCaseSensitive]);

  // Imperative pending-focus: parent flagged this card for focus (e.g.
  // user pressed ArrowDown in the neighbor above). Focus the editor at
  // the requested edge, then clear the pending state.
  useEffect(() => {
    if (!editor || !pendingFocus) return;
    editor.commands.focus(pendingFocus);
    onAutoFocused();
  }, [editor, pendingFocus, onAutoFocused]);

  // Surface the editor instance to the parent so the 3-dot BlockMenu can
  // run "Turn into" commands against it.
  useEffect(() => {
    onEditorReady(editor ?? null);
    return () => onEditorReady(null);
  }, [editor, onEditorReady]);

  useEffect(() => {
    if (!editor || editor.isFocused) return;
    const current = getMarkdownPreservingEmptyParas(editor);
    if (current.trim() !== block.content.trim()) {
      editor.commands.setContent(block.content, { emitUpdate: false });
    }
  }, [block.content, editor]);

  useEffect(() => () => saveDebounced.flush(), [saveDebounced]);

  return (
    <div className="text-sm">
      <BlockBubbleMenu editor={editor} />
      <EditorContent editor={editor} />
    </div>
  );
}

/**
 * Interactive tag chip strip. Each chip shows `#tag` with an `×` affordance
 * (visible on hover) for removal. When the card is open, an inline `+ tag`
 * input appears at the end of the row, accepting a tag name on Enter.
 *
 * Reads block.tags from the parent (the source of truth post-save); add /
 * remove route back through workspace.saveSnapshot so the chip strip stays
 * in lockstep with the block's stored content.
 */
function TagChipStrip({
  tags,
  showAdder,
  onAdd,
  onRemove,
}: {
  tags: string[];
  showAdder: boolean;
  onAdd: (tag: string) => void;
  onRemove: (tag: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
      {tags.map((t) => (
        <span
          key={t}
          className="group/chip inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-medium"
        >
          <span>#{t}</span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(t);
            }}
            title={`Remove #${t}`}
            className="opacity-0 group-hover/chip:opacity-100 transition-opacity text-blue-400 hover:text-blue-700 dark:hover:text-blue-200 leading-none"
          >
            ×
          </button>
        </span>
      ))}
      {showAdder && <TagAdder existing={tags} onAdd={onAdd} />}
    </div>
  );
}

/**
 * Detects whether the editor's cursor sits inside an in-progress
 * `#hashtag` token. Used to defer saves while the user is mid-typing
 * a tag — otherwise a brief pause after `#q` would land a partial
 * `q` tag in the block's tag set (and then `qw`, `qwe`, …). When the
 * user finishes the tag (space/blur/cursor-leaves), saves resume
 * normally and the full tag is captured.
 *
 * Pure text scan — no decoration / hide pass (hashtags are visible
 * in the editor while typing; they're stripped from content at save
 * time by the Rust `parser::strip_inline_hashtags`).
 */
const HASHTAG_RE_PER_CARD = /(^|\s)(#[A-Za-z][A-Za-z0-9_\-/]*)/g;

function cursorInsideHashtag(editor: Editor): boolean {
  const { doc, selection } = editor.state;
  const cursorPos = selection.head;
  let inside = false;
  doc.descendants((node, pos, parent) => {
    if (inside) return false;
    if (!node.isText || !node.text) return;
    if (
      parent &&
      (parent.type.name === "codeBlock" || parent.type.name === "code")
    ) {
      return;
    }
    if (node.marks.some((m) => m.type.name === "code")) return;
    HASHTAG_RE_PER_CARD.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HASHTAG_RE_PER_CARD.exec(node.text)) !== null) {
      // Tag-text range starts AFTER the leading whitespace (group 1):
      // typing inside `#xxx` is "in-progress"; clicking on the space
      // before it is not.
      const tagStart = pos + m.index + m[1].length;
      const tagEnd = pos + m.index + m[0].length;
      if (cursorPos >= tagStart && cursorPos <= tagEnd) {
        inside = true;
        return false;
      }
    }
  });
  return inside;
}

/**
 * Per-card search-match highlighter. The old single-doc canvas had a
 * `SearchHighlight` extension that decorated matches across all blocks;
 * here we run the same idea locally per editor and update via setMeta
 * whenever the parent's `highlightQuery` / `isActiveSearchHit` change.
 */
interface SearchHighlightState {
  query: string;
  active: boolean;
  caseSensitive: boolean;
  decos: DecorationSet;
}

const searchHighlightKey = new PluginKey<SearchHighlightState>(
  "searchHighlightPerCard",
);

function buildSearchHighlightDecos(
  doc: PMNode,
  query: string,
  active: boolean,
  caseSensitive: boolean,
): DecorationSet {
  if (!query) return DecorationSet.empty;
  const q = caseSensitive ? query : query.toLowerCase();
  const decos: Decoration[] = [];
  const cls = active ? "mochi-search-match-active" : "mochi-search-match";
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const haystack = caseSensitive ? node.text : node.text.toLowerCase();
    let from = 0;
    let idx = haystack.indexOf(q, from);
    while (idx >= 0) {
      decos.push(
        Decoration.inline(pos + idx, pos + idx + q.length, { class: cls }),
      );
      from = idx + q.length;
      idx = haystack.indexOf(q, from);
    }
  });
  return decos.length > 0 ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

const SearchHighlightPerCard = Extension.create({
  name: "searchHighlightPerCard",
  addProseMirrorPlugins() {
    return [
      new Plugin<SearchHighlightState>({
        key: searchHighlightKey,
        state: {
          init: () => ({
            query: "",
            active: false,
            caseSensitive: false,
            decos: DecorationSet.empty,
          }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(searchHighlightKey) as
              | { query: string; active: boolean; caseSensitive: boolean }
              | undefined;
            if (meta) {
              return {
                query: meta.query,
                active: meta.active,
                caseSensitive: meta.caseSensitive,
                decos: buildSearchHighlightDecos(
                  tr.doc,
                  meta.query,
                  meta.active,
                  meta.caseSensitive,
                ),
              };
            }
            if (tr.docChanged && prev.query) {
              return {
                ...prev,
                decos: buildSearchHighlightDecos(
                  tr.doc,
                  prev.query,
                  prev.active,
                  prev.caseSensitive,
                ),
              };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            return searchHighlightKey.getState(state)?.decos;
          },
        },
      }),
    ];
  },
});

/**
 * Inline tag-add input with live autocomplete below the field. Pulls
 * suggestions from the workspace's tag set, filtered by substring with
 * prefix priority (mirrors `Hashtag.ts`'s editor-side autocomplete). If
 * the typed value doesn't match any existing tag, a "create new" entry
 * appears at the top of the dropdown. Arrow keys navigate, Enter
 * commits, Esc closes.
 */
function TagAdder({
  existing,
  onAdd,
}: {
  existing: string[];
  onAdd: (tag: string) => void;
}) {
  const allTags = useWorkspace((s) => s.tags);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Anchor rect for the portaled dropdown. The input lives inside a
  // virtualized card (transformed ancestor), so the dropdown must be
  // portaled to body with viewport-relative fixed coords — otherwise it
  // gets clipped by sibling cards below in the feed.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Track the input's bounding rect so the portaled dropdown can follow
  // it through scrolls / window resizes.
  useLayoutEffect(() => {
    if (!open) {
      setAnchorRect(null);
      return;
    }
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      setAnchorRect(el.getBoundingClientRect());
    };
    measure();
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  // Close when clicking outside. Listen at the document level for
  // mousedown — the portaled dropdown is a child of body, NOT the
  // containerRef tree, so its click-targets need an explicit allow.
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (containerRef.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      if (draft.trim()) commit(draft.trim());
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open, draft]);

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase().replace(/^#/, "");
    const haveSet = new Set(existing);
    const candidates = allTags
      .map((t) => t.tag)
      .filter((t) => !haveSet.has(t));
    let filtered = candidates;
    if (q.length > 0) {
      const matches = candidates.filter((t) => t.toLowerCase().includes(q));
      // Prefix priority — `q` at the start ranks above arbitrary substring.
      matches.sort((a, b) => {
        const aPrefix = a.toLowerCase().startsWith(q);
        const bPrefix = b.toLowerCase().startsWith(q);
        if (aPrefix && !bPrefix) return -1;
        if (!aPrefix && bPrefix) return 1;
        return a.localeCompare(b);
      });
      filtered = matches.slice(0, 8);
    } else {
      filtered = candidates.slice(0, 8);
    }
    // If the typed query is a valid tag name and doesn't already match
    // an existing one exactly, offer "Create new".
    const createSlot: { kind: "create"; name: string }[] =
      q.length > 0 &&
      /^[A-Za-z][A-Za-z0-9_\-/]*$/.test(q) &&
      !candidates.some((t) => t.toLowerCase() === q)
        ? [{ kind: "create", name: q }]
        : [];
    return [
      ...createSlot,
      ...filtered.map((t) => ({ kind: "existing" as const, name: t })),
    ];
  }, [draft, existing, allTags]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [draft]);

  const commit = (name: string) => {
    const t = name.trim().toLowerCase().replace(/^#/, "");
    if (t) onAdd(t);
    setDraft("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        title="Add tag"
        className="px-2 py-0.5 rounded-full border border-dashed border-blue-300 dark:border-blue-700 text-blue-500 dark:text-blue-400 text-xs hover:bg-blue-50 dark:hover:bg-blue-900/30"
      >
        + tag
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/^#/, ""))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHighlightIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const pick = suggestions[highlightIdx];
            if (pick) commit(pick.name);
            else if (draft.trim()) commit(draft.trim());
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft("");
            setOpen(false);
          }
        }}
        placeholder="tag"
        className="px-2 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-medium font-mono w-24 outline-none placeholder:text-blue-400/60"
      />
      {open && suggestions.length > 0 && anchorRect &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: anchorRect.bottom + 4,
              left: anchorRect.left,
              zIndex: 60,
            }}
            className="w-44 max-h-56 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1 text-xs"
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((s, idx) => {
              const active = idx === highlightIdx;
              return (
                <button
                  key={`${s.kind}:${s.name}`}
                  onMouseEnter={() => setHighlightIdx(idx)}
                  onClick={() => commit(s.name)}
                  className={`w-full flex items-center gap-1.5 px-2 py-1 text-left ${
                    active
                      ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
                >
                  <span className="font-mono">#{s.name}</span>
                  {s.kind === "create" && (
                    <span className="ml-auto text-[10px] text-neutral-400">
                      new
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

interface CrossBlockNavOptions {
  onAppendBelow: () => void;
  onMergeUp: () => void;
  onFocusNext: () => void;
  onFocusPrev: () => void;
  onSplitHere: () => void;
}

/**
 * Cross-card keyboard navigation. The per-card editor only knows about its
 * own doc, so this extension translates "Enter at the end of an empty
 * paragraph", "Backspace at start", and "Arrow up/down past the textblock
 * edge" into hooks that the canvas-level CanvasFeed routes to neighbor
 * cards. This is the per-card equivalent of `KeyboardActions` in the old
 * single-doc canvas.
 */
const CrossBlockNav = Extension.create<CrossBlockNavOptions>({
  name: "crossBlockNav",
  addOptions() {
    return {
      onAppendBelow: () => {},
      onMergeUp: () => {},
      onFocusNext: () => {},
      onFocusPrev: () => {},
      onSplitHere: () => {},
    };
  },
  addKeyboardShortcuts() {
    return {
      "Mod-Enter": () => {
        // Split the current block at the cursor — the half before stays
        // in the original block, the half after lands in a new block
        // below. Same path as the BlockMenu's "Split here" item.
        this.options.onSplitHere();
        return true;
      },
      // Enter is a pure paragraph split inside the current block now.
      // The previous "Enter on a trailing empty line escapes to a new
      // card" path was too easy to trigger accidentally — the user
      // hits Enter twice to leave space and the second one mints a
      // block they didn't want. Cmd-Enter (handled above) is the
      // explicit "make a new block" shortcut.
      // Returning false lets PM run its native split behavior.
      Backspace: () => {
        const { state } = this.editor;
        const { selection } = state;
        if (!selection.empty) return false;
        // At position 1 = inside the very first text node, at offset 0.
        if (selection.$head.pos !== 1) return false;
        this.options.onMergeUp();
        return true;
      },
      ArrowDown: () => {
        const view = this.editor.view;
        if (!view.endOfTextblock("down")) return false;
        // At bottom visual line of current textblock — only escape if
        // this is also the last textblock in the doc.
        const { selection, doc } = this.editor.state;
        let isLastTextblock = true;
        doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          if (pos > selection.head) {
            isLastTextblock = false;
            return false;
          }
          return true;
        });
        if (!isLastTextblock) return false;
        this.options.onFocusNext();
        return true;
      },
      ArrowUp: () => {
        const view = this.editor.view;
        if (!view.endOfTextblock("up")) return false;
        const { selection, doc } = this.editor.state;
        let isFirstTextblock = true;
        doc.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          if (pos < selection.head) {
            isFirstTextblock = false;
            return false;
          }
          return true;
        });
        if (!isFirstTextblock) return false;
        this.options.onFocusPrev();
        return true;
      },
    };
  },
});

/**
 * Compact popover that lists tags to pick from. Used in the bulk-action
 * toolbar for "Add tag…" (lists every workspace tag + allows creating
 * a new one) and "Remove tag…" (lists only the intersection of tags
 * across selected blocks, so the action always has an effect).
 */
function BulkTagButton({
  label,
  mode,
  tagCandidates,
  excludeIntersection,
  onPick,
}: {
  label: string;
  mode?: "remove";
  /** When mode === "remove", this is the tag intersection across selected
   *  blocks (the only tags that can be removed). When undefined or
   *  mode !== "remove", we show all workspace tags. */
  tagCandidates: string[];
  excludeIntersection?: boolean;
  onPick: (tag: string) => void;
}) {
  const allTags = useWorkspace((s) => s.tags);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAnchorRect(null);
      return;
    }
    const measure = () => {
      const el = ref.current?.querySelector("button");
      if (!el) return;
      setAnchorRect(el.getBoundingClientRect());
    };
    measure();
    const onScroll = () => measure();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase().replace(/^#/, "");
    let candidates: string[];
    if (mode === "remove") {
      candidates = tagCandidates.filter((t) => !q || t.toLowerCase().includes(q));
    } else {
      const excluded = excludeIntersection ? new Set(tagCandidates) : new Set();
      candidates = allTags
        .map((t) => t.tag)
        .filter((t) => !excluded.has(t))
        .filter((t) => !q || t.toLowerCase().includes(q));
    }
    candidates.sort((a, b) => {
      if (!q) return 0;
      const ap = a.toLowerCase().startsWith(q);
      const bp = b.toLowerCase().startsWith(q);
      if (ap && !bp) return -1;
      if (!ap && bp) return 1;
      return a.localeCompare(b);
    });
    const trimmed = candidates.slice(0, 12);
    if (
      mode !== "remove" &&
      q.length > 0 &&
      /^[A-Za-z][A-Za-z0-9_\-/]*$/.test(q) &&
      !allTags.some((t) => t.tag === q)
    ) {
      return [{ kind: "create" as const, name: q }, ...trimmed.map((t) => ({ kind: "existing" as const, name: t }))];
    }
    return trimmed.map((t) => ({ kind: "existing" as const, name: t }));
  }, [draft, allTags, tagCandidates, mode, excludeIntersection]);

  useEffect(() => {
    setHighlightIdx(0);
  }, [draft]);

  const pick = (name: string) => {
    onPick(name);
    setDraft("");
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <ToolbarBtn
        onClick={() => setOpen((v) => !v)}
        title={mode === "remove" ? "Remove a tag from selected blocks" : "Add a tag to selected blocks"}
        icon={mode === "remove" ? <X size={13} /> : <Plus size={13} />}
      >
        {label}
      </ToolbarBtn>
      {open && anchorRect &&
        createPortal(
        <div
          ref={dropdownRef}
          style={{
            position: "fixed",
            top: anchorRect.bottom + 4,
            // Anchor to the right edge of the button so the dropdown
            // flows leftward — keeps it on-screen when the button sits
            // near the right side of the toolbar.
            right: window.innerWidth - anchorRect.right,
            zIndex: 60,
          }}
          className="w-56 max-h-72 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl"
          onMouseDown={(e) => e.preventDefault()}
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/^#/, ""))}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlightIdx((i) => Math.min(i + 1, suggestions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlightIdx((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const s = suggestions[highlightIdx];
                if (s) pick(s.name);
                else if (mode !== "remove" && draft.trim()) pick(draft.trim());
              } else if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                setDraft("");
              }
            }}
            placeholder={mode === "remove" ? "Filter tags…" : "tag or new"}
            className="w-full px-2 py-1.5 text-sm border-b border-neutral-100 dark:border-neutral-800 outline-none bg-transparent"
          />
          {suggestions.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">
              {mode === "remove"
                ? "No tags shared across selected blocks."
                : "No matches."}
            </div>
          )}
          {suggestions.map((s, idx) => (
            <button
              key={`${s.kind}:${s.name}`}
              onMouseEnter={() => setHighlightIdx(idx)}
              onClick={() => pick(s.name)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left ${
                idx === highlightIdx
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                  : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              <span className="font-mono">#{s.name}</span>
              {s.kind === "create" && (
                <span className="ml-auto text-[10px] text-neutral-400">new</span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function ToolbarBtn({
  onClick,
  icon,
  children,
  title,
  disabled,
  tone,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
  title: string;
  disabled?: boolean;
  tone?: "warn" | "danger";
}) {
  const cls =
    tone === "danger"
      ? "bg-red-600 hover:bg-red-700 text-white"
      : tone === "warn"
        ? "border border-amber-300 dark:border-amber-700 bg-white dark:bg-neutral-900 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/30"
        : "border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 hover:bg-neutral-100 dark:hover:bg-neutral-800";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${cls} disabled:opacity-40`}
    >
      {icon} {children}
    </button>
  );
}

/**
 * Heuristic markdown splitter — each top-level chunk (paragraph, heading,
 * or list item) becomes its own block on a "Split" bulk action. Fenced
 * code stays whole. Lifted from `TagsView.splitContentIntoChunks`.
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

function asBlockInput(b: StoredBlock, override?: Partial<BlockInput>): BlockInput {
  const out: BlockInput = {
    id: b.id,
    content: override?.content ?? b.content,
    position: override?.position ?? b.position,
    parent_id: override?.parent_id ?? b.parent_id,
    heading: override?.heading ?? b.heading,
    heading_level: override?.heading_level ?? b.heading_level,
  };
  // Only forward `tags` / `pinned_scopes` / `title` when the caller
  // explicitly passed them. Omitting from BlockInput tells the backend
  // to preserve prior state for those fields — important for pure-
  // position reorders / structural edits.
  if (override && "tags" in override) out.tags = override.tags;
  if (override && "pinned_scopes" in override) out.pinned_scopes = override.pinned_scopes;
  if (override && "title" in override) out.title = override.title;
  return out;
}

/**
 * Walk a position-ordered block list and assign `parent_id` based on
 * heading-level nesting (same rule as the Rust-side parser). Mirrors
 * `TagsView.recomputeParentIds`.
 */
function recomputeParentIds<T extends BlockInput>(ordered: T[]): T[] {
  const stack: { id: string; level: number }[] = [];
  return ordered.map((b) => {
    if (b.heading_level != null) {
      while (
        stack.length &&
        stack[stack.length - 1].level >= b.heading_level
      ) {
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

function deriveHeading(md: string): { heading: string | null; level: number | null } {
  const m = md.match(/^[ \t]*(#{1,6})[ \t]+(.+?)[ \t]*$/m);
  if (!m) return { heading: null, level: null };
  return { heading: m[2].trim() || null, level: m[1].length };
}

/**
 * Strip the leading block-type marker from a markdown line so a "Turn
 * into …" rewrite can replace it cleanly. Removes leading `#`s, bullet /
 * numbered / task list prefixes, and the `>` quote marker. Code-fence
 * wrappers are stripped by a simpler heuristic — drop opening/closing
 * triple-backtick lines.
 */
function formatDateRange(from: number | null, to: number | null): string {
  const fmt = (ts: number) =>
    new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  if (from != null && to != null) return `${fmt(from)} – ${fmt(to)}`;
  if (from != null) return `since ${fmt(from)}`;
  if (to != null) return `before ${fmt(to)}`;
  return "all time";
}

/** Compact "edited 2h ago"-style format. Used in each card's top bar. */
function relativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(d / 365)}y`;
}

function stripBlockPrefix(content: string): string {
  const lines = content.split("\n");
  // Code fence removal — first and last line if they're ``` fences.
  if (
    lines.length >= 2 &&
    lines[0].trim().startsWith("```") &&
    lines[lines.length - 1].trim().startsWith("```")
  ) {
    return lines.slice(1, -1).join("\n");
  }
  return lines
    .map((line) =>
      line
        .replace(/^[ \t]*#{1,6}[ \t]+/, "")
        .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/, "")
        .replace(/^[ \t]*[-*+][ \t]+/, "")
        .replace(/^[ \t]*\d+\.[ \t]+/, "")
        .replace(/^[ \t]*>[ \t]?/, ""),
    )
    .join("\n");
}

/**
 * Modal that opens a focused, full-size editor for a single block. Same
 * extension set as the inline editor, but laid out as a centered card
 * with comfortable typography. The inline card stays mounted underneath
 * — the workspace store is the source of truth, so edits in either
 * surface flow through `saveSnapshot` and re-render the other.
 */
/**
 * Full-size editor for a single block. Replaces the card feed in place
 * (sidebar + top bar still visible) — no overlay, no backdrop. Used for
 * deep work on one block: bigger type, comfortable margins, no
 * cross-block keyboard nav. Close with Esc or the "Back to feed"
 * button.
 */
function ExpandedBlockEditor({
  blockId,
  onClose,
  onSelectTag,
}: {
  blockId: string;
  onClose: () => void;
  onSelectTag?: (tag: string) => void;
}) {
  const block = useWorkspace((s) =>
    s.blocks.find((b) => b.id === blockId) ?? null,
  );
  const tags = useWorkspace((s) => s.tags);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);
  const tagsRef = useRef(tags);
  useEffect(() => {
    tagsRef.current = tags;
  }, [tags]);
  const blockRef = useRef(block);
  useEffect(() => {
    blockRef.current = block;
  }, [block]);
  const saveSnapshotRef = useRef(saveSnapshot);
  useEffect(() => {
    saveSnapshotRef.current = saveSnapshot;
  }, [saveSnapshot]);

  const saveDebounced = useMemo(
    () =>
      debounce((md: string) => {
        const b = blockRef.current;
        if (!b) return;
        const cleaned = unescapeInlineHashtags(md);
        if (cleaned === b.content) return;
        const { heading, level } = deriveHeading(cleaned);
        void saveSnapshotRef.current(
          [
            {
              id: b.id,
              content: cleaned,
              position: b.position,
              parent_id: b.parent_id,
              heading,
              heading_level: level,
            },
          ],
          [],
        );
      }, 300),
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: "mochi-link" },
        },
      }),
      UnderlineExtension,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, linkify: true, breaks: false }),
      Placeholder.configure({
        placeholder: "Type / for commands…",
        showOnlyWhenEditable: true,
      }),
      Hashtag.configure({
        getTags: () => tagsRef.current.map((t) => t.tag),
      }),
      SlashMenu,
    ],
    content: block?.content ?? "",
    autofocus: "end",
    onUpdate: ({ editor }) => {
      // Same in-progress-tag skip as the inline editor — see comment
      // there. Prevents partial `#q` from saving as a real `q` tag.
      if (cursorInsideHashtag(editor)) {
        saveDebounced.cancel();
        return;
      }
      const md = getMarkdownPreservingEmptyParas(editor);
      saveDebounced(md);
    },
    onSelectionUpdate: ({ editor }) => {
      if (cursorInsideHashtag(editor)) return;
      const md = getMarkdownPreservingEmptyParas(editor);
      saveDebounced(md);
    },
    onBlur: ({ editor }) => {
      saveDebounced.flush();
      const md = getMarkdownPreservingEmptyParas(editor);
      saveDebounced(md);
      saveDebounced.flush();
    },
  });

  // External content updates (e.g. inline edit while modal open) — refresh
  // the modal editor only when it isn't currently focused, so we don't
  // clobber the user's typing.
  useEffect(() => {
    if (!editor || editor.isFocused || !block) return;
    const current = getMarkdownPreservingEmptyParas(editor);
    if (current.trim() !== block.content.trim()) {
      editor.commands.setContent(block.content, { emitUpdate: false });
    }
  }, [block?.content, editor]);

  useEffect(() => () => saveDebounced.flush(), [saveDebounced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!block) return null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Slim header — no bottom border, no panel background. Just the
          back button + tag chips + id. Feels like a page header, not a
          card chrome. */}
      <div className="flex items-center justify-between px-6 py-3 text-sm">
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
          title="Back to feed (Esc)"
        >
          <ArrowLeft size={14} />
          Back to feed
        </button>
        <div className="flex items-center gap-2 flex-1 mx-4 justify-end overflow-hidden">
          {block.tags.map((t) => (
            <button
              key={t}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTag?.(t);
              }}
              title={`Open #${t} (exits fullscreen)`}
              className="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs font-medium hover:bg-blue-200 dark:hover:bg-blue-900/70 cursor-pointer ring-1 ring-blue-200 dark:ring-blue-800"
            >
              #{t}
            </button>
          ))}
          <span className="font-mono text-xs text-neutral-400 ml-2 shrink-0">
            {block.id.slice(-8)}
          </span>
        </div>
      </div>
      {/* Full-page editor — no card border, no rounded corners. The
          body fills the panel with a comfortable readable column and
          generous top padding so the first line sits where you'd
          expect on a "page." Match Obsidian / Apple Notes feel. */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-10 pt-12 pb-32 text-base leading-relaxed mochi-expanded-editor">
          <ExpandedTitleField
            blockId={block.id}
            initialTitle={block.title}
          />
          <BlockBubbleMenu editor={editor} />
          <EditorContent editor={editor} />
        </div>
      </div>
    </div>
  );
}

/**
 * Page-title-style title input for the fullscreen editor. Routes
 * commits through saveSnapshot directly (rather than a prop callback)
 * since ExpandedBlockEditor already owns its own save plumbing.
 */
function ExpandedTitleField({
  blockId,
  initialTitle,
}: {
  blockId: string;
  initialTitle: string | null;
}) {
  const blocks = useWorkspace((s) => s.blocks);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);
  const runWithUndo = useWorkspace((s) => s.runWithUndo);
  const [draft, setDraft] = useState<string>(initialTitle ?? "");
  useEffect(() => {
    setDraft(initialTitle ?? "");
  }, [initialTitle]);
  const commit = async () => {
    const b = blocks.find((x) => x.id === blockId);
    if (!b) return;
    const t = draft.trim();
    if ((b.title ?? "") === t) return;
    await runWithUndo(t ? "Set title" : "Clear title", async () => {
      await saveSnapshot([asBlockInput(b, { title: t })], []);
    });
  };
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(initialTitle ?? "");
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder="Untitled"
      className="w-full mb-6 bg-transparent outline-none border-none text-3xl font-bold text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 placeholder:italic placeholder:font-normal"
    />
  );
}

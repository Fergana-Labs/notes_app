import { useRef } from "react";
import { Settings as SettingsIcon } from "lucide-react";
import { TagsPane } from "./TagsPane";
import { SearchResultsPane } from "./SearchResultsPane";
import { useDragRegion } from "../hooks/useDragRegion";
import { useUISettings } from "../stores/uiSettings";

interface Props {
  tagFilter: string | null;
  searchQuery: string;
  caseSensitive: boolean;
  searchActiveId: string | null;
  onSelectTag: (tag: string) => void;
  onClearFilter: () => void;
  onJumpToSearchResult: (id: string) => void;
  onOpenSettings: () => void;
}

/**
 * Sidebar — single pane, just tags. The Canvas/Sections tab was removed
 * along with the heading-tree navigation; the canvas itself is now a
 * unified card feed that filters by the tag selected here. Search
 * (top-bar) swaps the tags list out for an in-document match list while
 * the query is active.
 */
export function Sidebar({
  tagFilter,
  searchQuery,
  caseSensitive,
  searchActiveId,
  onSelectTag,
  onClearFilter,
  onJumpToSearchResult,
  onOpenSettings,
}: Props) {
  const navRef = useRef<HTMLElement>(null);
  useDragRegion(navRef);
  const colorful = useUISettings((s) => s.colorful);

  const searchActive = searchQuery.trim().length > 0;

  // Colorful mode: the actual deep sage from stash_desktop's sidebar
  // (`--sidebar: #557153` + `--sidebar-border: #4a6741`). Same colors
  // light and dark — the sidebar reads as a colored chrome rather
  // than a tinted surface. Inner content overrides for white-on-green
  // text live in index.css (scoped to `.colorful aside`).
  const surfaceClass = colorful
    ? "bg-[#557153] text-white"
    : "bg-white/40 dark:bg-neutral-950/40";
  const borderClass = colorful
    ? "border-[#4a6741]"
    : "border-neutral-200 dark:border-neutral-800";

  return (
    <aside
      className={`w-72 border-r flex flex-col backdrop-blur shrink-0 ${surfaceClass} ${borderClass}`}
    >
      {/* Header bar aligned with the top-bar height. `pl-[80px]` clears the
          macOS traffic-light buttons (overlaid because of titleBarStyle:
          Overlay). The whole strip is a tauri drag region so the window
          can be moved by empty parts of it. */}
      <nav
        ref={navRef}
        data-tauri-drag-region
        className="h-11 pl-[80px] pr-3 border-b border-neutral-200 dark:border-neutral-800 select-none"
      />
      {searchActive && (
        <div className="px-3 py-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 border-b border-neutral-100 dark:border-neutral-800">
          Search
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {searchActive ? (
          <SearchResultsPane
            query={searchQuery}
            caseSensitive={caseSensitive}
            activeId={searchActiveId}
            onJump={(id) => onJumpToSearchResult(id)}
          />
        ) : (
          <TagsPane
            selected={tagFilter}
            onOpenTag={onSelectTag}
            onClearTag={onClearFilter}
          />
        )}
      </div>

      <button
        onClick={onOpenSettings}
        className="flex items-center gap-2 px-3 py-2 text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 border-t border-neutral-200 dark:border-neutral-800"
      >
        <SettingsIcon size={14} />
        <span>Settings</span>
      </button>
    </aside>
  );
}

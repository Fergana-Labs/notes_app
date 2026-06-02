import { useRef } from "react";
import {
  Settings as SettingsIcon,
  Trash2,
  CalendarDays,
  Star,
  Hash,
} from "lucide-react";
import { TagsPane } from "./TagsPane";
import { DailyNotesList } from "./DailyNotesList";
import { SearchResultsPane } from "./SearchResultsPane";
import { todayStr } from "../lib/daily";
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
  trashActive: boolean;
  onOpenTrash: () => void;
  /** Currently-open daily note date (for highlighting), or null. */
  dailyDate: string | null;
  onSelectDaily: (date: string) => void;
}

/**
 * Sidebar. A top icon row switches the list between three sources: the
 * daily-notes archive, the priority-tags shortlist, and all tags. An
 * active search overrides the list with in-document match results. Trash
 * and Settings live in the footer.
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
  trashActive,
  onOpenTrash,
  dailyDate,
  onSelectDaily,
}: Props) {
  const navRef = useRef<HTMLElement>(null);
  useDragRegion(navRef);
  const colorful = useUISettings((s) => s.colorful);
  const sidebarView = useUISettings((s) => s.sidebarView);
  const setSidebarView = useUISettings((s) => s.setSidebarView);

  const searchActive = searchQuery.trim().length > 0;

  const surfaceClass = colorful
    ? "bg-[#557153] text-white"
    : "bg-white/40 dark:bg-neutral-950/40";
  const borderClass = colorful
    ? "border-[#4a6741]"
    : "border-neutral-200 dark:border-neutral-800";

  const tabs = [
    { id: "daily", label: "Daily", icon: CalendarDays },
    { id: "priority", label: "Priority", icon: Star },
    { id: "all", label: "All tags", icon: Hash },
  ] as const;

  return (
    <aside
      className={`w-72 border-r flex flex-col backdrop-blur shrink-0 ${surfaceClass} ${borderClass}`}
    >
      <nav
        ref={navRef}
        data-tauri-drag-region
        className="h-11 pl-[80px] pr-3 border-b border-neutral-200 dark:border-neutral-800 select-none"
      />

      {searchActive ? (
        <>
          <div className="px-3 py-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400 border-b border-neutral-100 dark:border-neutral-800">
            Search
          </div>
          <div className="flex-1 overflow-y-auto">
            <SearchResultsPane
              query={searchQuery}
              caseSensitive={caseSensitive}
              activeId={searchActiveId}
              onJump={(id) => onJumpToSearchResult(id)}
            />
          </div>
        </>
      ) : (
        <>
          {/* Source switcher: daily notes / priority tags / all tags. */}
          <div className="flex items-center gap-1 px-2 pt-2 pb-1">
            {tabs.map((t) => {
              const active = sidebarView === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => {
                    void setSidebarView(t.id);
                    // Hitting the calendar jumps straight to today's note,
                    // rather than just showing the list.
                    if (t.id === "daily") onSelectDaily(todayStr());
                  }}
                  title={t.label}
                  className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded text-xs ${
                    active
                      ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                      : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
                >
                  <t.icon size={14} />
                  <span className="hidden xl:inline">{t.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex-1 overflow-y-auto">
            {sidebarView === "daily" ? (
              <DailyNotesList selectedDate={dailyDate} onSelect={onSelectDaily} />
            ) : (
              <TagsPane
                selected={tagFilter}
                onOpenTag={onSelectTag}
                onClearTag={onClearFilter}
                scope={sidebarView === "priority" ? "priority" : "all"}
              />
            )}
          </div>
        </>
      )}

      <button
        onClick={onOpenTrash}
        className={`flex items-center gap-2 px-3 py-2 text-xs border-t border-neutral-200 dark:border-neutral-800 ${
          trashActive
            ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium"
            : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        }`}
      >
        <Trash2 size={14} />
        <span>Trash</span>
      </button>
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

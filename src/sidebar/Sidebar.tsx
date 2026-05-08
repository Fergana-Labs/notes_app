import { useEffect, useRef, useState } from "react";
import { ListTree, Hash, Settings as SettingsIcon } from "lucide-react";
import { SectionsPane } from "./SectionsPane";
import { TagsPane } from "./TagsPane";
import { useDragRegion } from "../hooks/useDragRegion";
import type { MainView } from "../App";

type Tab = "canvas" | "tags";

interface Props {
  mainView: MainView;
  tagFilter: string | null;
  onShowCanvas: () => void;
  onShowTags: () => void;
  onSelectTag: (tag: string) => void;
  onClearFilter: () => void;
  onJumpToBlock: (id: string) => void;
  onOpenSettings: () => void;
}

/**
 * Two sidebar tabs:
 *
 * - **Canvas** — heading tree of the canvas. Selecting this tab also tells
 *   the main panel to show the canvas editor.
 * - **Tags** — list of tags with counts. Selecting this tab puts the main
 *   panel into TagsView (all blocks, sortable & selectable). Clicking a
 *   specific tag filters the TagsView to just that tag's blocks.
 *
 * Search lives in the top bar (above the main panel), not here.
 */
export function Sidebar({
  mainView,
  tagFilter,
  onShowCanvas,
  onShowTags,
  onSelectTag,
  onClearFilter,
  onJumpToBlock,
  onOpenSettings,
}: Props) {
  const [tab, setTab] = useState<Tab>(mainView === "canvas" ? "canvas" : "tags");
  const navRef = useRef<HTMLElement>(null);
  useDragRegion(navRef);

  useEffect(() => {
    if (mainView === "canvas") setTab("canvas");
    else setTab("tags");
  }, [mainView]);

  return (
    <aside className="w-72 border-r border-neutral-200 dark:border-neutral-800 flex flex-col bg-white/40 dark:bg-neutral-950/40 backdrop-blur shrink-0">
      {/* Tab strip aligned with the top-bar height. `pl-[80px]` clears the
          macOS traffic-light buttons (which overlay the top-left because
          we use titleBarStyle: Overlay). The whole strip is a tauri drag
          region so the window can be moved by the empty parts of it. */}
      <nav
        ref={navRef}
        data-tauri-drag-region
        className="flex h-11 pl-[80px] border-b border-neutral-200 dark:border-neutral-800 text-xs select-none"
      >
        <TabBtn
          label="Canvas"
          icon={<ListTree size={14} />}
          active={tab === "canvas"}
          onClick={() => {
            setTab("canvas");
            onShowCanvas();
          }}
        />
        <TabBtn
          label="Tags"
          icon={<Hash size={14} />}
          active={tab === "tags"}
          onClick={() => {
            setTab("tags");
            onShowTags();
          }}
        />
      </nav>

      <div className="flex-1 overflow-y-auto">
        {tab === "canvas" && <SectionsPane onJump={onJumpToBlock} />}
        {tab === "tags" && (
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

function TabBtn({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1 py-2 ${
        active
          ? "border-b-2 border-blue-500 text-neutral-900 dark:text-neutral-100"
          : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

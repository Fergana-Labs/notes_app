import { useEffect, useState } from "react";
import { Search, ListTree, Hash, Settings as SettingsIcon } from "lucide-react";
import { SearchPane } from "./SearchPane";
import { SectionsPane } from "./SectionsPane";
import { TagsPane } from "./TagsPane";

type Tab = "search" | "sections" | "tags";

interface Props {
  onOpenTag: (tag: string) => void;
  onJumpToBlock: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({ onOpenTag, onJumpToBlock, onOpenSettings }: Props) {
  const [tab, setTab] = useState<Tab>("sections");

  useEffect(() => {
    const onFocusSearch = () => setTab("search");
    window.addEventListener("mochi:focus-search", onFocusSearch);
    return () => window.removeEventListener("mochi:focus-search", onFocusSearch);
  }, []);

  return (
    <aside className="w-72 border-r border-neutral-200 dark:border-neutral-800 flex flex-col bg-white/40 dark:bg-neutral-950/40 backdrop-blur">
      <nav className="flex border-b border-neutral-200 dark:border-neutral-800 text-xs">
        <TabBtn
          label="Search"
          icon={<Search size={14} />}
          active={tab === "search"}
          onClick={() => setTab("search")}
        />
        <TabBtn
          label="Sections"
          icon={<ListTree size={14} />}
          active={tab === "sections"}
          onClick={() => setTab("sections")}
        />
        <TabBtn
          label="Tags"
          icon={<Hash size={14} />}
          active={tab === "tags"}
          onClick={() => setTab("tags")}
        />
      </nav>

      <div className="flex-1 overflow-y-auto">
        {tab === "search" && <SearchPane onJump={onJumpToBlock} />}
        {tab === "sections" && <SectionsPane onJump={onJumpToBlock} />}
        {tab === "tags" && <TagsPane onOpenTag={onOpenTag} />}
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

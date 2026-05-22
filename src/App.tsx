import { useEffect, useRef, useState } from "react";
import { Sidebar } from "./sidebar/Sidebar";
import { CanvasFeed } from "./editor/CanvasFeed";
import { ChatBox } from "./editor/ChatBox";
import { SettingsModal } from "./settings/SettingsModal";
import { TopBarSearch, type DateRange } from "./topbar/TopBarSearch";
import { useWorkspace } from "./stores/workspace";
import { useUISettings } from "./stores/uiSettings";
import { useDragRegion } from "./hooks/useDragRegion";
import { ipc } from "./lib/ipc";

export default function App() {
  const path = useWorkspace((s) => s.path);
  const bootstrap = useWorkspace((s) => s.bootstrap);
  const error = useWorkspace((s) => s.error);
  const loading = useWorkspace((s) => s.loading);
  const reload = useWorkspace((s) => s.reload);

  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [highlightQuery, setHighlightQuery] = useState<string>("");
  // Block id the user most recently jumped to from a search result.
  // Drives the active-hit highlight color inside the feed.
  const [searchActiveId, setSearchActiveId] = useState<string | null>(null);
  // When set, the main feed shows ONLY this block — used by clicks on
  // sidebar search results to give the user a single-block focused view
  // instead of a scroll-and-highlight pulse.
  const [focusedBlockId, setFocusedBlockId] = useState<string | null>(null);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Track fullscreen single-block view at App level so the ChatBox can
  // adapt its placeholder. The state itself lives in CanvasFeed; this
  // mirror is read-only.
  const [feedFullscreen, setFeedFullscreen] = useState(false);

  const headerRef = useRef<HTMLElement>(null);
  useDragRegion(headerRef);

  const loadUISettings = useUISettings((s) => s.load);
  const colorful = useUISettings((s) => s.colorful);
  const compact = useUISettings((s) => s.compact);
  const hideHeaders = useUISettings((s) => s.hideHeaders);
  useEffect(() => {
    bootstrap();
    loadUISettings();
  }, [bootstrap, loadUISettings]);
  // Toggle a root `.colorful` class so the sage-palette overrides in
  // index.css activate. Scope is global (the class lives on <html>)
  // so portaled menus + modals inherit the palette too.
  useEffect(() => {
    document.documentElement.classList.toggle("colorful", colorful);
  }, [colorful]);
  useEffect(() => {
    document.documentElement.classList.toggle("compact", compact);
  }, [compact]);
  useEffect(() => {
    document.documentElement.classList.toggle("hide-headers", hideHeaders);
  }, [hideHeaders]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (key === "f" || key === "k")) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("mochi:focus-search"));
        return;
      }
      if (mod && key === "n") {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("mochi:focus-chatbox"));
        return;
      }
      // Cmd-Z in a non-editing context: undo the last bulk action.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "z" &&
        !e.shiftKey
      ) {
        const target = e.target as HTMLElement | null;
        const inEditable =
          !!target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable);
        if (inEditable) return;
        e.preventDefault();
        useWorkspace.getState().undoLast();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Agent-edit detector: poll blocks.db mtime every 2s. Only triggers a
  // full reload when the on-disk mtime is meaningfully ahead of what we
  // last saw — a 1-second slack window absorbs the in-flight mtime bumps
  // from our own saves so typing in a 2k-block doc doesn't kick off a
  // redundant `listBlocks` round-trip every 2s.
  useEffect(() => {
    if (!path) return;
    const SLACK_MS = 1000;
    let cancelled = false;
    const tick = async () => {
      try {
        const m = await ipc.blocksMtime();
        if (cancelled) return;
        const known = useWorkspace.getState().lastMtime;
        if (known === 0) {
          useWorkspace.setState({ lastMtime: m });
        } else if (m > known + SLACK_MS) {
          // Probably an external (agent / restore) write — pull fresh state.
          useWorkspace.setState({ lastMtime: m });
          await reload();
        }
      } catch {
        /* ignore */
      }
    };
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [path, reload]);

  // Debounce the highlight query the same way `SearchResultsPane` debounces
  // its IPC search — typing into the search field doesn't synchronously
  // re-mark every visible card.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setHighlightQuery("");
      return;
    }
    const id = window.setTimeout(() => setHighlightQuery(q), 120);
    return () => window.clearTimeout(id);
  }, [searchQuery]);

  if (!path) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-md">
          <h1 className="text-3xl font-bold mb-2">Mochi</h1>
          {error ? (
            <p className="text-red-600 text-sm mb-2">{error}</p>
          ) : (
            <p className="text-neutral-500 text-sm">
              {loading ? "Loading…" : "Starting up…"}
            </p>
          )}
        </div>
      </div>
    );
  }

  // Sidebar search-result click. Narrow the feed to just this one block
  // (no scroll-pulse, no jump) — clicking another result swaps the focus,
  // and the "× clear" chip on the feed returns to the full list.
  const jumpToBlock = (id: string) => {
    setSearchActiveId(id);
    setFocusedBlockId(id);
  };

  return (
    <div className="h-full flex">
      <Sidebar
        tagFilter={tagFilter}
        searchQuery={searchQuery}
        caseSensitive={caseSensitive}
        searchActiveId={searchActiveId}
        onSelectTag={(tag) => {
          setTagFilter(tag);
          setSearchActiveId(null);
        }}
        onClearFilter={() => setTagFilter(null)}
        onJumpToSearchResult={jumpToBlock}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        <header
          ref={headerRef}
          data-tauri-drag-region
          className="flex items-center gap-3 px-3 h-11 border-b border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-950/60 backdrop-blur select-none shrink-0"
        >
          <TopBarSearch
            value={searchQuery}
            onChange={(q) => {
              setSearchQuery(q);
              setSearchActiveId(null);
              setFocusedBlockId(null);
            }}
            caseSensitive={caseSensitive}
            onCaseSensitiveChange={setCaseSensitive}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            tagFilter={tagFilter}
          />
        </header>
        <div className="flex-1 flex flex-col overflow-hidden">
          <CanvasFeed
            key={path}
            searchQuery={highlightQuery}
            caseSensitive={caseSensitive}
            activeSearchId={searchActiveId}
            tagFilter={tagFilter}
            onClearTagFilter={() => setTagFilter(null)}
            onSelectTag={(tag) => {
              setTagFilter(tag);
              setSearchActiveId(null);
              setFocusedBlockId(null);
            }}
            focusedBlockId={focusedBlockId}
            onClearFocusedBlock={() => {
              setFocusedBlockId(null);
              setSearchActiveId(null);
            }}
            dateRange={dateRange}
            onClearDateRange={() => setDateRange({ from: null, to: null })}
            onFullscreenChange={setFeedFullscreen}
          />
          <ChatBox tagFilter={tagFilter} fullscreen={feedFullscreen} />
        </div>
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

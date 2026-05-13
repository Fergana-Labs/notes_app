import { useEffect, useRef, useState } from "react";
import { Sidebar } from "./sidebar/Sidebar";
import { CanvasEditor } from "./editor/CanvasEditor";
import { ChatBox } from "./editor/ChatBox";
import { TagsView } from "./tags-view/TagsView";
import { SettingsModal } from "./settings/SettingsModal";
import { TopBarSearch } from "./topbar/TopBarSearch";
import { useWorkspace } from "./stores/workspace";
import { useDragRegion } from "./hooks/useDragRegion";
import { ipc } from "./lib/ipc";
import { getCanvasEditor } from "./editor/editorRef";
import { setSearchState } from "./editor/extensions/SearchHighlight";

export type MainView = "canvas" | "tags";

export default function App() {
  const path = useWorkspace((s) => s.path);
  const bootstrap = useWorkspace((s) => s.bootstrap);
  const error = useWorkspace((s) => s.error);
  const loading = useWorkspace((s) => s.loading);
  const reload = useWorkspace((s) => s.reload);

  const [mainView, setMainView] = useState<MainView>("canvas");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [highlightQuery, setHighlightQuery] = useState<string>("");
  // Block id the user most recently jumped to from a search result.
  // Drives the "active" variant of the in-editor search highlight.
  const [searchActiveId, setSearchActiveId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const headerRef = useRef<HTMLElement>(null);
  useDragRegion(headerRef);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("mochi:focus-search"));
        return;
      }
      // Cmd-Z in the tags / search view: undo the last bulk action.
      if (
        (e.metaKey || e.ctrlKey) &&
        e.key.toLowerCase() === "z" &&
        !e.shiftKey &&
        (mainView === "tags" || searchQuery.trim().length > 0)
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
  }, [mainView, searchQuery]);

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

  // Keep the input itself immediate, but debounce the editor-wide decoration
  // rebuild. SearchResultsPane already debounces the IPC query; this gives the
  // same treatment to in-canvas highlighting so typing in the search field
  // does not synchronously scan a large document per keypress.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setHighlightQuery("");
      return;
    }
    const id = window.setTimeout(() => setHighlightQuery(q), 120);
    return () => window.clearTimeout(id);
  }, [searchQuery]);

  // Push the debounced search query + active block into the editor so its
  // SearchHighlight plugin can underline every match in place. Lives ABOVE
  // the splash early-return — hooks must be called unconditionally, in the
  // same order, on every render (React error #310 otherwise).
  useEffect(() => {
    const editor = getCanvasEditor();
    if (!editor) return;
    setSearchState(editor, highlightQuery, highlightQuery ? searchActiveId : null);
  }, [highlightQuery, searchActiveId]);

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

  const jumpTo = (id: string) => {
    setMainView("canvas");
    setTagFilter(null);
    setSearchQuery("");
    setSearchActiveId(null);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        (el as HTMLElement).animate(
          [{ background: "rgba(255,225,0,0.3)" }, { background: "transparent" }],
          { duration: 1500 },
        );
      }
    });
  };

  // Search-result jump: keeps the query (and the sidebar results panel)
  // intact so the user can flip between matches, and tags the focused
  // block id so the SearchHighlight extension can up-shade matches
  // inside it. Mirrors Apple Notes' search behavior.
  const jumpToSearchResult = (id: string) => {
    setMainView("canvas");
    setTagFilter(null);
    setSearchActiveId(id);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-block-id="${CSS.escape(id)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  };

  return (
    <div className="h-full flex">
      <Sidebar
        mainView={mainView}
        tagFilter={tagFilter}
        searchQuery={searchQuery}
        searchActiveId={searchActiveId}
        onShowCanvas={() => {
          setMainView("canvas");
          setTagFilter(null);
          setSearchQuery("");
          setSearchActiveId(null);
        }}
        onShowTags={() => {
          setMainView("tags");
          setSearchQuery("");
          setSearchActiveId(null);
        }}
        onSelectTag={(tag) => {
          setMainView("tags");
          setTagFilter(tag);
          setSearchQuery("");
          setSearchActiveId(null);
        }}
        onClearFilter={() => {
          setMainView("tags");
          setTagFilter(null);
        }}
        onJumpToBlock={jumpTo}
        onJumpToSearchResult={jumpToSearchResult}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Search header lives only over the main panel — the sidebar gets
            the rest of the title-bar row to itself (with traffic-light
            padding). `data-tauri-drag-region` lets the user drag by the
            empty parts of the bar; the input opts out automatically. */}
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
            }}
            tagFilter={mainView === "tags" ? tagFilter : null}
          />
        </header>
        {/*
          The CanvasEditor + ChatBox tree is mounted exactly once per
          workspace (`key={path}`). On large docs (2k+ blocks) re-mounting
          it is the single biggest cost when toggling between Canvas and
          Tags. Instead of unmount/remount we hide it via `display: none`
          while another view is active. State (cursor, scroll position,
          ProseMirror history) is preserved.
        */}
        <div
          className="flex-1 flex flex-col overflow-hidden"
          style={{
            display: mainView === "canvas" ? "flex" : "none",
          }}
        >
          <CanvasEditor key={path} />
          <ChatBox />
        </div>

        {mainView === "tags" && (
          <TagsView
            tagFilter={tagFilter}
            searchQuery={searchQuery}
            onClearFilter={() => setTagFilter(null)}
            onClearSearch={() => setSearchQuery("")}
            onJumpToBlock={jumpTo}
          />
        )}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

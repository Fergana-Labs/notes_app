import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar/Sidebar";
import { CanvasEditor } from "./editor/CanvasEditor";
import { ChatBox } from "./editor/ChatBox";
import { TagPage } from "./tag-view/TagPage";
import { SettingsModal } from "./settings/SettingsModal";
import { ChronoView } from "./chrono/ChronoView";
import { ViewModeToggle, type ViewMode } from "./chrono/ViewModeToggle";
import { useWorkspace } from "./stores/workspace";
import { ipc } from "./lib/ipc";

export default function App() {
  const path = useWorkspace((s) => s.path);
  const bootstrap = useWorkspace((s) => s.bootstrap);
  const error = useWorkspace((s) => s.error);
  const loading = useWorkspace((s) => s.loading);
  const reload = useWorkspace((s) => s.reload);

  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");

  // Boot the workspace on mount. With the new app-data-dir bootstrap, there's
  // no folder picker landing screen — the user lands directly in their notes.
  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // ⌘F / Ctrl+F → focus search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new Event("mochi:focus-search"));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Agent-edit detector: poll blocks.db mtime every 2s. If it changes
  // unexpectedly (i.e. not as a result of our own save), reload the block list
  // so external writes (an agent UPDATEing rows directly) flow into the editor.
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const m = await ipc.blocksMtime();
        if (cancelled) return;
        const known = useWorkspace.getState().lastMtime;
        if (known === 0) {
          useWorkspace.setState({ lastMtime: m });
        } else if (m > known) {
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
    if (activeTag) setActiveTag(null);
    if (viewMode !== "canvas") setViewMode("canvas");
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

  return (
    <div className="h-full flex">
      <Sidebar
        onOpenTag={setActiveTag}
        onJumpToBlock={jumpTo}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 text-xs text-neutral-500 flex items-center gap-2">
          {!activeTag && (
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
          )}
        </header>
        {activeTag ? (
          <TagPage tag={activeTag} onClose={() => setActiveTag(null)} />
        ) : viewMode === "canvas" ? (
          <>
            <CanvasEditor key={path} />
            <ChatBox />
          </>
        ) : (
          <ChronoView mode={viewMode} onJumpToBlock={jumpTo} />
        )}
      </main>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

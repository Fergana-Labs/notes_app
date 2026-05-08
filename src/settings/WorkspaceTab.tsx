import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Move } from "lucide-react";
import { useWorkspace } from "../stores/workspace";

/**
 * Workspace settings: shows the current workspace path, lets the user point
 * Mochi at a different folder ("Switch") or move the current data to a new
 * disk location ("Move").
 *
 * Switch: just changes the active path. Whatever's at the destination is
 * adopted (an existing `.notesapp/` is opened; an empty folder is seeded).
 *
 * Move: physically relocates `.notesapp/` and the legacy markdown sidecar
 * from the current root to the destination, then switches to it. Refuses if
 * the destination already contains a Mochi workspace.
 */
export function WorkspaceTab() {
  const path = useWorkspace((s) => s.path);
  const switchWorkspace = useWorkspace((s) => s.switchWorkspace);
  const moveWorkspace = useWorkspace((s) => s.moveWorkspace);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSwitch = async () => {
    setError(null);
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    setBusy(true);
    try {
      await switchWorkspace(picked);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onMove = async () => {
    setError(null);
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked !== "string") return;
    if (
      !window.confirm(
        `Move workspace data to:\n${picked}\n\nThe .notesapp/ folder and legacy markdown will be moved to this location.`,
      )
    )
      return;
    setBusy(true);
    try {
      await moveWorkspace(picked);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-sm font-semibold mb-1">Active workspace</h3>
        <code className="block text-xs px-2 py-1.5 rounded bg-neutral-100 dark:bg-neutral-800 break-all">
          {path ?? "(none)"}
        </code>
        <p className="mt-2 text-xs text-neutral-500">
          On first launch Mochi creates a default workspace under your app-data
          directory. You can switch to a different folder anytime, or move the
          current data to a new location.
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <button
          onClick={onSwitch}
          disabled={busy}
          className="flex items-center gap-2 text-sm px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 self-start"
        >
          <FolderOpen size={14} /> Switch workspace…
        </button>
        <button
          onClick={onMove}
          disabled={busy}
          className="flex items-center gap-2 text-sm px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 self-start"
        >
          <Move size={14} /> Move workspace data…
        </button>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </section>
    </div>
  );
}

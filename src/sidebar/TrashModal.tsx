import { useEffect, useState } from "react";
import { X, Undo2, Trash2 } from "lucide-react";
import { ipc, type StoredBlock } from "../lib/ipc";
import { useWorkspace } from "../stores/workspace";

/**
 * Trash view — soft-deleted notes, kept until the user restores or
 * permanently deletes them. Opened from the sidebar footer.
 */
export function TrashModal({ onClose }: { onClose: () => void }) {
  const reload = useWorkspace((s) => s.reload);
  const [items, setItems] = useState<StoredBlock[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => ipc.listTrash().then(setItems).catch(() => setItems([]));
  useEffect(() => {
    refresh();
  }, []);

  const restore = async (id: string) => {
    setBusy(true);
    try {
      await ipc.restoreBlock(id);
      await reload(); // pull the restored block back into the live feed
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const purge = async (id: string) => {
    if (!window.confirm("Permanently delete this note? This can't be undone."))
      return;
    setBusy(true);
    try {
      const remaining = await ipc.purgeBlock(id);
      setItems(remaining);
    } finally {
      setBusy(false);
    }
  };

  const emptyAll = async () => {
    if (!items || items.length === 0) return;
    if (
      !window.confirm(
        `Permanently delete all ${items.length} note${items.length === 1 ? "" : "s"} in the trash? This can't be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      await ipc.emptyTrash();
      setItems([]);
    } finally {
      setBusy(false);
    }
  };

  const preview = (b: StoredBlock): string => {
    const title = (b.title ?? "").trim();
    if (title) return title;
    for (const raw of b.content.split("\n")) {
      const line = raw.trim();
      if (line && line !== " ") {
        return line
          .replace(/^#{1,6}\s+/, "")
          .replace(/^[-*+]\s+\[[ xX]\]\s+/, "")
          .replace(/^[-*+]\s+/, "")
          .replace(/^\d+\.\s+/, "")
          .replace(/^>\s?/, "");
      }
    }
    return "Empty note";
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <h2 className="font-semibold flex items-center gap-2">
            <Trash2 size={16} /> Trash
            {items && items.length > 0 && (
              <span className="text-xs font-normal text-neutral-400">
                {items.length}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            {items && items.length > 0 && (
              <button
                onClick={emptyAll}
                disabled={busy}
                className="text-xs px-2 py-1 rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
              >
                Empty trash
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {items === null ? (
            <div className="p-6 text-center text-sm text-neutral-400">
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="p-10 text-center text-sm text-neutral-400">
              Trash is empty.
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((b) => (
                <li
                  key={b.id}
                  className="group flex items-center gap-2 px-3 py-2 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                >
                  <span className="flex-1 min-w-0 truncate text-sm text-neutral-700 dark:text-neutral-200">
                    {preview(b)}
                  </span>
                  {b.tags.slice(0, 2).map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-[10px] font-medium shrink-0"
                    >
                      #{t}
                    </span>
                  ))}
                  <button
                    onClick={() => void restore(b.id)}
                    disabled={busy}
                    title="Restore"
                    className="p-1 rounded text-neutral-400 hover:text-green-600 dark:hover:text-green-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
                  >
                    <Undo2 size={14} />
                  </button>
                  <button
                    onClick={() => void purge(b.id)}
                    disabled={busy}
                    title="Delete forever"
                    className="p-1 rounded text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Trash2, Undo2, X } from "lucide-react";
import { ipc, type StoredBlock } from "../lib/ipc";
import { useWorkspace } from "../stores/workspace";

/**
 * Trash, rendered in the main panel like a tag view (not a modal).
 * Lists soft-deleted notes with Restore / Delete-forever per item plus
 * an Empty-trash action. Kept until the user purges them.
 */
export function TrashPane({ onClose }: { onClose: () => void }) {
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
      await reload();
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
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toolbar — mirrors the feed's sticky header row. */}
      <div className="px-6 pt-4 pb-2 border-b border-neutral-100 dark:border-neutral-800/60 shrink-0">
        <div className="max-w-3xl mx-auto flex items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-medium text-neutral-700 dark:text-neutral-200">
            <Trash2 size={15} /> Trash
          </span>
          <span className="text-neutral-500">
            {items === null
              ? "loading…"
              : `${items.length} note${items.length === 1 ? "" : "s"}`}
          </span>
          {items && items.length > 0 && (
            <button
              onClick={emptyAll}
              disabled={busy}
              className="ml-auto text-xs px-2 py-1 rounded border border-red-200 dark:border-red-900/50 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
            >
              Empty trash
            </button>
          )}
          <button
            onClick={onClose}
            title="Back to notes"
            className={`${items && items.length > 0 ? "" : "ml-auto"} text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200`}
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pt-4 pb-32">
        <div className="max-w-3xl mx-auto">
          {items === null ? (
            <div className="p-10 text-center text-sm text-neutral-400">
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="p-16 text-center text-sm text-neutral-400">
              Trash is empty.
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((b) => (
                <li
                  key={b.id}
                  className="group flex items-center gap-2 px-3 py-2 rounded-md border border-neutral-100 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                >
                  <span className="flex-1 min-w-0 truncate text-sm text-neutral-700 dark:text-neutral-200">
                    {preview(b)}
                  </span>
                  {b.tags.slice(0, 3).map((t) => (
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
                    <Undo2 size={15} />
                  </button>
                  <button
                    onClick={() => void purge(b.id)}
                    disabled={busy}
                    title="Delete forever"
                    className="p-1 rounded text-neutral-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50"
                  >
                    <Trash2 size={15} />
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

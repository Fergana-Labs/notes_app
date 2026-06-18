import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import { useWorkspace } from "../stores/workspace";
import type { StoredBlock } from "../lib/ipc";

/** First non-empty line of a block, for the picker label. */
function blockLabel(b: StoredBlock): string {
  const title = (b.title ?? "").trim();
  if (title) return title;
  const first = b.content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.trim() || "(empty note)";
}

interface Props {
  /** Currently selected note id, or null. */
  selectedId: string | null;
  onPick: (noteId: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/**
 * Lightweight note chooser: searches the workspace's blocks and lets the user
 * pick one (as a coach persona / system prompt) or clear the current pick.
 * Reads from the synced workspace store, so it works offline.
 */
export function NotePicker({ selectedId, onPick, onClear, onClose }: Props) {
  const blocks = useWorkspace((s) => s.blocks);
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = blocks
      .map((b) => ({ b, label: blockLabel(b) }))
      .filter(({ b, label }) =>
        q ? label.toLowerCase().includes(q) || b.content.toLowerCase().includes(q) : true,
      );
    return list.slice(0, 100);
  }, [blocks, query]);

  return (
    <div className="flex flex-col gap-2 w-72 max-h-80 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl p-2 text-sm">
      <div className="flex items-center gap-1.5 px-1.5 py-1 rounded border border-neutral-200 dark:border-neutral-700">
        <Search size={13} className="shrink-0 text-neutral-400" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes for a persona"
          className="flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col">
        {selectedId && (
          <button
            onClick={() => {
              onClear();
              onClose();
            }}
            className="flex items-center gap-2 px-2 py-1.5 text-left rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
          >
            <X size={13} /> Clear persona
          </button>
        )}
        {results.map(({ b, label }) => {
          const active = b.id === selectedId;
          return (
            <button
              key={b.id}
              onClick={() => {
                onPick(b.id);
                onClose();
              }}
              className={`px-2 py-1.5 text-left rounded truncate ${
                active
                  ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 font-medium"
                  : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
              title={label}
            >
              {label}
            </button>
          );
        })}
        {results.length === 0 && (
          <p className="px-2 py-2 text-xs text-neutral-500">No matching notes.</p>
        )}
      </div>
    </div>
  );
}

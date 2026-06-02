import { useState } from "react";
import { X } from "lucide-react";
import { extractInlineTags } from "../lib/markdown";

/**
 * Modal shown when adding a daily note to your notes. Lists each
 * horizontal-rule-delimited segment with a checkbox so the user can pick
 * which ones become blocks (all selected by default). Shows a preview and
 * the tags each segment would get.
 */
export function DailyFlushModal({
  segments,
  onClose,
  onConfirm,
}: {
  segments: string[];
  onClose: () => void;
  onConfirm: (selected: string[]) => void;
}) {
  const [checked, setChecked] = useState<boolean[]>(() =>
    segments.map(() => true),
  );
  const selectedCount = checked.filter(Boolean).length;
  const allOn = selectedCount === segments.length;

  const toggle = (i: number) =>
    setChecked((prev) => prev.map((v, idx) => (idx === i ? !v : v)));
  const setAll = (on: boolean) => setChecked(segments.map(() => on));

  const confirm = () => {
    const selected = segments.filter((_, i) => checked[i]);
    if (selected.length > 0) onConfirm(selected);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="bg-white dark:bg-neutral-900 rounded-lg w-full max-w-xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <h2 className="font-semibold text-sm">Add to notes</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex items-center gap-3 px-4 py-2 text-xs text-neutral-500 border-b border-neutral-100 dark:border-neutral-800/60">
          <span>
            {segments.length} entr{segments.length === 1 ? "y" : "ies"} (split
            on “---”)
          </span>
          <button
            onClick={() => setAll(!allOn)}
            className="ml-auto text-blue-600 dark:text-blue-400 hover:underline"
          >
            {allOn ? "Deselect all" : "Select all"}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {segments.map((seg, i) => {
            const tags = extractInlineTags(seg);
            return (
              <label
                key={i}
                className={`flex gap-3 px-3 py-2 rounded-md cursor-pointer border ${
                  checked[i]
                    ? "border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-900/15"
                    : "border-neutral-100 dark:border-neutral-800/60 hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked[i]}
                  onChange={() => toggle(i)}
                  className="mt-0.5 shrink-0 cursor-pointer"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-700 dark:text-neutral-200 whitespace-pre-wrap line-clamp-4 break-words">
                    {seg}
                  </div>
                  {tags.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {tags.map((t) => (
                        <span
                          key={t}
                          className="px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-[10px] font-medium"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </label>
            );
          })}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={confirm}
            disabled={selectedCount === 0}
            className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            Add {selectedCount} to notes
          </button>
        </div>
      </div>
    </div>
  );
}

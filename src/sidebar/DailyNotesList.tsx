import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { ipc, type DailyNoteMeta } from "../lib/ipc";
import { todayStr, dailyDateLabel, dailyGroupLabel } from "../lib/daily";

/**
 * Sidebar list of daily notes, newest first. Today is always shown at the
 * top (even before it has content). Older notes are grouped by recency
 * (This week / Last week / month / month-year) so the list stays
 * navigable as it grows.
 */
export function DailyNotesList({
  selectedDate,
  onSelect,
}: {
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const [notes, setNotes] = useState<DailyNoteMeta[]>([]);
  const today = todayStr();

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      ipc
        .listDailyNotes()
        .then((n) => {
          if (!cancelled) setNotes(n);
        })
        .catch(() => {});
    refresh();
    window.addEventListener("mochi:daily-saved", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("mochi:daily-saved", refresh);
    };
  }, []);

  // Ensure Today is present at the top even when it has no saved content.
  const withToday: DailyNoteMeta[] = notes.some((n) => n.date === today)
    ? notes
    : [{ date: today, updated_at: 0, preview: "" }, ...notes];

  // Group consecutively by bucket label, preserving date-desc order.
  const groups: { label: string; items: DailyNoteMeta[] }[] = [];
  for (const n of withToday) {
    const label = dailyGroupLabel(n.date);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }

  return (
    <div className="p-2 space-y-2">
      <button
        onClick={() => onSelect(today)}
        className="w-full flex items-center gap-2 text-sm px-2 py-1.5 rounded border border-dashed border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <Plus size={14} /> Open today’s note
      </button>

      {groups.map((g) => (
        <div key={g.label} className="space-y-0.5">
          <div className="px-2 pt-1 text-[10px] uppercase tracking-wide text-neutral-400">
            {g.label}
          </div>
          {g.items.map((n) => {
            const active = selectedDate === n.date;
            return (
              <button
                key={n.date}
                onClick={() => onSelect(n.date)}
                className={`w-full text-left px-2 py-1.5 rounded ${
                  active
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium truncate">
                    {dailyDateLabel(n.date)}
                  </span>
                  <span className="text-[10px] text-neutral-400 shrink-0">
                    {n.date.slice(5)}
                  </span>
                </div>
                {n.preview ? (
                  <div className="text-xs text-neutral-400 truncate">
                    {n.preview}
                  </div>
                ) : n.date === today ? (
                  <div className="text-xs text-neutral-400 italic">Empty</div>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

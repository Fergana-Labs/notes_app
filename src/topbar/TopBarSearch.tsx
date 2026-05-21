import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CaseSensitive, Calendar, Search, X } from "lucide-react";

export interface DateRange {
  from: number | null;
  to: number | null;
}

interface Props {
  value: string;
  onChange: (q: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (v: boolean) => void;
  dateRange: DateRange;
  onDateRangeChange: (r: DateRange) => void;
  /** Used cosmetically for the placeholder. */
  tagFilter?: string | null;
}

/**
 * Top-bar search input + filter pickers. Cmd-F / Cmd-K focuses the input
 * (via the `mochi:focus-search` event). Aa toggle controls case-sensitive
 * search; Calendar opens a popover with date-range presets.
 */
export function TopBarSearch({
  value,
  onChange,
  caseSensitive,
  onCaseSensitiveChange,
  dateRange,
  onDateRangeChange,
  tagFilter,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusInput = () => {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    window.addEventListener("mochi:focus-search", focusInput);
    return () => window.removeEventListener("mochi:focus-search", focusInput);
  }, []);

  const rangeActive = dateRange.from != null || dateRange.to != null;

  return (
    <div className="relative flex items-center gap-1.5 flex-1 max-w-xl">
      <div className="relative flex-1">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400 pointer-events-none"
        />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onChange("");
              inputRef.current?.blur();
            }
          }}
          placeholder={tagFilter ? `Search #${tagFilter}…` : "Search blocks…"}
          className="w-full pl-8 pr-7 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 focus:border-neutral-400 dark:focus:border-neutral-600 outline-none transition-colors"
        />
        {value && (
          <button
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
            }}
            title="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <button
        onClick={() => onCaseSensitiveChange(!caseSensitive)}
        title={caseSensitive ? "Case-sensitive search" : "Case-insensitive search"}
        className={`p-1.5 rounded-md border ${
          caseSensitive
            ? "border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
            : "border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        }`}
      >
        <CaseSensitive size={14} />
      </button>
      <DateFilter
        value={dateRange}
        onChange={onDateRangeChange}
        active={rangeActive}
      />
    </div>
  );
}

const DAY = 24 * 60 * 60 * 1000;

function DateFilter({
  value,
  onChange,
  active,
}: {
  value: DateRange;
  onChange: (r: DateRange) => void;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showCustom, setShowCustom] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Portal anchor — the popover is rendered into document.body so it
  // escapes any clipping from the header's `backdrop-blur` containing
  // block / `main`'s `overflow:hidden`. Position is computed from the
  // calendar button rect.
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAnchorRect(null);
      return;
    }
    const measure = () => {
      const btn = ref.current?.querySelector("button");
      if (!btn) return;
      setAnchorRect(btn.getBoundingClientRect());
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
      setShowCustom(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const setPreset = (preset: string) => {
    const now = Date.now();
    const startOfToday = startOfDay(new Date(now)).getTime();
    let from: number | null = null;
    let to: number | null = null;
    switch (preset) {
      case "all":
        from = null;
        to = null;
        break;
      case "today":
        from = startOfToday;
        break;
      case "yesterday":
        from = startOfToday - DAY;
        to = startOfToday;
        break;
      case "week":
        from = startOfToday - 7 * DAY;
        break;
      case "month":
        from = startOfToday - 30 * DAY;
        break;
    }
    onChange({ from, to });
    setOpen(false);
    setShowCustom(false);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Filter by date"
        className={`p-1.5 rounded-md border ${
          active
            ? "border-blue-400 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
            : "border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        }`}
      >
        <Calendar size={14} />
      </button>
      {open && anchorRect &&
        createPortal(
        <div
          ref={popoverRef}
          style={{
            position: "fixed",
            top: anchorRect.bottom + 4,
            right: window.innerWidth - anchorRect.right,
            zIndex: 70,
          }}
          className="w-52 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl py-1 text-sm"
        >
          <PresetBtn label="All time" onClick={() => setPreset("all")} />
          <PresetBtn label="Today" onClick={() => setPreset("today")} />
          <PresetBtn label="Yesterday" onClick={() => setPreset("yesterday")} />
          <PresetBtn label="This week" onClick={() => setPreset("week")} />
          <PresetBtn label="This month" onClick={() => setPreset("month")} />
          <div className="border-t border-neutral-100 dark:border-neutral-800 mt-1 pt-1">
            <PresetBtn
              label={showCustom ? "Custom range…" : "Custom range…"}
              onClick={() => setShowCustom((v) => !v)}
            />
            {showCustom && (
              <div className="px-3 py-2 flex flex-col gap-1 text-xs">
                <label className="flex items-center gap-2">
                  <span className="w-10 text-neutral-500">From</span>
                  <input
                    type="date"
                    value={isoDay(value.from)}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        from: e.target.value
                          ? new Date(e.target.value).getTime()
                          : null,
                      })
                    }
                    className="flex-1 px-1.5 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950"
                  />
                </label>
                <label className="flex items-center gap-2">
                  <span className="w-10 text-neutral-500">To</span>
                  <input
                    type="date"
                    value={isoDay(value.to)}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        to: e.target.value
                          ? new Date(e.target.value).getTime() + DAY
                          : null,
                      })
                    }
                    className="flex-1 px-1.5 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-950"
                  />
                </label>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function PresetBtn({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    >
      {label}
    </button>
  );
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function isoDay(ts: number | null): string {
  if (ts == null) return "";
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

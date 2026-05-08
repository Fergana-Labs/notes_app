import { LayoutList, ArrowDownNarrowWide, ArrowUpNarrowWide } from "lucide-react";

export type ViewMode = "canvas" | "newest" | "oldest";

const OPTIONS: { value: ViewMode; label: string; icon: React.ReactNode; title: string }[] = [
  {
    value: "canvas",
    label: "Canvas",
    icon: <LayoutList size={12} />,
    title: "Document order — full editor",
  },
  {
    value: "newest",
    label: "Newest",
    icon: <ArrowDownNarrowWide size={12} />,
    title: "Most recently edited first (read-only)",
  },
  {
    value: "oldest",
    label: "Oldest",
    icon: <ArrowUpNarrowWide size={12} />,
    title: "Oldest first by last edit (read-only)",
  },
];

export function ViewModeToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded border border-neutral-200 dark:border-neutral-800 overflow-hidden text-xs">
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          title={opt.title}
          className={`flex items-center gap-1 px-2 py-1 transition-colors ${
            value === opt.value
              ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              : "text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          {opt.icon}
          <span>{opt.label}</span>
        </button>
      ))}
    </div>
  );
}

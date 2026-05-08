import { useEffect, useRef } from "react";
import { Search, X } from "lucide-react";

interface Props {
  value: string;
  onChange: (q: string) => void;
  /** Used cosmetically for the placeholder. */
  tagFilter?: string | null;
}

/**
 * Top-bar search input. Cmd-F focuses it (via the global `mochi:focus-search`
 * event). The query is propagated up to App, which renders the matching
 * blocks inline in the main panel — read-only when canvas-mode, editable
 * when tags-mode. No dropdown.
 */
export function TopBarSearch({ value, onChange, tagFilter }: Props) {
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

  return (
    <div className="relative flex-1 max-w-xl">
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
  );
}

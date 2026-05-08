import { useEffect, useRef, useState } from "react";
import { ipc, type SearchHit } from "../lib/ipc";

export function SearchPane({ onJump }: { onJump: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      ipc.search(q, 50).then(setHits).catch(() => setHits([]));
    }, 150);
    return () => clearTimeout(t);
  }, [q]);

  // Focus on mount and whenever the global "mochi:focus-search" event fires
  // (Cmd+F triggers it from anywhere).
  useEffect(() => {
    const focusInput = () => {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    focusInput();
    window.addEventListener("mochi:focus-search", focusInput);
    return () => window.removeEventListener("mochi:focus-search", focusInput);
  }, []);

  return (
    <div className="p-3 space-y-3">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setQ("");
            inputRef.current?.blur();
          }
        }}
        placeholder="Search blocks…"
        className="w-full px-2 py-1.5 text-sm rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900"
      />
      <ul className="space-y-1 text-sm">
        {hits.map((h) => (
          <li key={h.id}>
            <button
              onClick={() => onJump(h.id)}
              className="w-full text-left p-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
            >
              {h.heading && (
                <div className="font-semibold text-neutral-700 dark:text-neutral-200">{h.heading}</div>
              )}
              <div
                className="text-xs text-neutral-500"
                dangerouslySetInnerHTML={{ __html: h.snippet }}
              />
            </button>
          </li>
        ))}
        {q.trim() && hits.length === 0 && (
          <li className="text-xs text-neutral-500 italic">No results.</li>
        )}
      </ul>
    </div>
  );
}

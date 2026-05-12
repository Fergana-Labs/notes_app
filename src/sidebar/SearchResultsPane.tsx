import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { ipc, type SearchHit } from "../lib/ipc";

interface Props {
  query: string;
  activeId: string | null;
  onJump: (id: string, query: string) => void;
}

/**
 * Apple-Notes-style search panel: lists every block matching the active
 * search query and lets the user click between matches without losing the
 * query. The canvas stays visible underneath, and clicking a result
 * scrolls + highlights the match in place (see SearchHighlight extension).
 *
 * We deliberately don't subscribe to the workspace `blocks` array here —
 * its reference changes on every save (~3/sec while typing), and on a
 * 2k-block canvas the re-render + position-sort was adding measurable
 * keystroke latency. Hits come back from the FTS index already ordered
 * by rank, which is fine for navigation; using that order also means
 * the pane stays stable while the user edits matched blocks.
 */
export function SearchResultsPane({ query, activeId, onJump }: Props) {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(() => {
      ipc
        .search(q, 200)
        .then((res) => {
          if (cancelled) return;
          setHits(res);
        })
        .catch(() => {
          if (cancelled) return;
          setHits([]);
        })
        .finally(() => {
          if (cancelled) return;
          setSearching(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const ordered = hits ?? [];

  if (!query.trim()) return null;

  return (
    <div className="p-2 flex flex-col gap-1">
      <div className="px-1 pb-1 text-xs text-neutral-500">
        {searching
          ? "Searching…"
          : `${ordered.length} match${ordered.length === 1 ? "" : "es"}`}
      </div>
      {!searching && ordered.length === 0 && (
        <p className="px-2 py-1 text-xs text-neutral-500 italic">
          No matches for "{query.trim()}".
        </p>
      )}
      <ul className="space-y-0.5">
        {ordered.map((h) => {
          const active = activeId === h.id;
          return (
            <li key={h.id}>
              <button
                onClick={() => onJump(h.id, query)}
                className={`group w-full text-left rounded px-2 py-1.5 text-xs transition-colors ${
                  active
                    ? "bg-blue-100 dark:bg-blue-900/40 text-blue-900 dark:text-blue-100"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-200"
                }`}
              >
                {h.heading && (
                  <div className="font-semibold truncate">{h.heading}</div>
                )}
                <div
                  className="text-neutral-500 dark:text-neutral-400 line-clamp-2"
                  dangerouslySetInnerHTML={{ __html: h.snippet }}
                />
                <div className="hidden group-hover:flex items-center gap-1 mt-1 text-[10px] text-neutral-400">
                  <ArrowRight size={10} /> jump to block
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

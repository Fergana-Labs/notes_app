import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import MarkdownIt from "markdown-it";
// @ts-expect-error — no shipped types for markdown-it-task-lists
import taskLists from "markdown-it-task-lists";
import { useWorkspace } from "../stores/workspace";
import type { ViewMode } from "./ViewModeToggle";

const md = new MarkdownIt({ html: false, linkify: true, breaks: false }).use(
  taskLists,
  { enabled: true, label: false },
);

/**
 * Read-only chronological view of all blocks. Sorted by `updated_at` —
 * newest-first or oldest-first. Each entry has a "Jump to canvas" button
 * that switches back to canvas mode and scrolls / highlights the block.
 *
 * No editor mounts here, no Tiptap. Plain rendered HTML — fast even on
 * thousand-block documents, and unambiguous: edits go through the canvas.
 */
export function ChronoView({
  mode,
  onJumpToBlock,
}: {
  mode: Exclude<ViewMode, "canvas">;
  onJumpToBlock: (id: string) => void;
}) {
  const blocks = useWorkspace((s) => s.blocks);

  const sorted = useMemo(() => {
    const arr = [...blocks];
    arr.sort((a, b) =>
      mode === "newest"
        ? b.updated_at - a.updated_at
        : a.updated_at - b.updated_at,
    );
    return arr;
  }, [blocks, mode]);

  return (
    <div className="flex-1 overflow-y-auto px-6 pt-4 pb-12">
      <div className="max-w-3xl mx-auto space-y-3">
        <p className="text-xs text-neutral-500 italic">
          Read-only · sorted by last edit ({mode === "newest" ? "newest" : "oldest"} first)
          · {sorted.length} block{sorted.length === 1 ? "" : "s"}
        </p>
        {sorted.map((b) => (
          <article
            key={b.id}
            className="group relative rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4"
          >
            <div className="flex items-center justify-between gap-3 text-[11px] text-neutral-500 mb-2">
              <span>
                {new Date(b.updated_at).toLocaleString()}
                {b.created_at !== b.updated_at && (
                  <>
                    {" "}
                    · created{" "}
                    {new Date(b.created_at).toLocaleDateString()}
                  </>
                )}
              </span>
              <button
                onClick={() => onJumpToBlock(b.id)}
                className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-0.5 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-opacity"
                title="Open in canvas to edit"
              >
                Jump to canvas <ArrowRight size={11} />
              </button>
            </div>
            <div
              className="prose-block text-sm"
              dangerouslySetInnerHTML={{ __html: md.render(b.content || "") }}
            />
            {b.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-2">
                {b.tags.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
                  >
                    #{t}
                  </span>
                ))}
              </div>
            )}
          </article>
        ))}
        {sorted.length === 0 && (
          <p className="text-sm text-neutral-500 italic">No blocks yet.</p>
        )}
      </div>
    </div>
  );
}

import { useWorkspace } from "../stores/workspace";

interface Props {
  selected: string | null;
  onOpenTag: (tag: string) => void;
  onClearTag: () => void;
}

export function TagsPane({ selected, onOpenTag, onClearTag }: Props) {
  const tags = useWorkspace((s) => s.tags);

  return (
    <div className="p-2 space-y-0.5">
      <button
        onClick={onClearTag}
        className={`w-full flex justify-between text-sm px-2 py-1 rounded ${
          selected == null
            ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
            : "hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
        }`}
      >
        <span>All blocks</span>
        <span className="text-neutral-400">
          {tags.reduce((sum, t) => sum + t.count, 0) === 0 ? "" : ""}
        </span>
      </button>

      {tags.length === 0 && (
        <p className="px-2 py-1 text-xs text-neutral-500 italic">
          No tags yet. Use <code>#foo</code> inline in any block.
        </p>
      )}

      {tags.map((t) => {
        const active = selected === t.tag;
        return (
          <button
            key={t.tag}
            onClick={() => onOpenTag(t.tag)}
            className={`w-full flex justify-between text-sm px-2 py-1 rounded ${
              active
                ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
            }`}
          >
            <span>#{t.tag}</span>
            <span className="text-neutral-400">{t.count}</span>
          </button>
        );
      })}
    </div>
  );
}

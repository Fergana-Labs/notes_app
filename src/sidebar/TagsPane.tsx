import { useWorkspace } from "../stores/workspace";

export function TagsPane({ onOpenTag }: { onOpenTag: (tag: string) => void }) {
  const tags = useWorkspace((s) => s.tags);

  if (tags.length === 0) {
    return (
      <p className="p-3 text-xs text-neutral-500 italic">
        No tags yet. Use #foo inline in any block.
      </p>
    );
  }

  return (
    <ul className="p-2 space-y-0.5">
      {tags.map((t) => (
        <li key={t.tag}>
          <button
            onClick={() => onOpenTag(t.tag)}
            className="w-full flex justify-between text-sm px-2 py-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <span>#{t.tag}</span>
            <span className="text-neutral-400">{t.count}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

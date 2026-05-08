import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type KeyboardEvent,
} from "react";

export interface HashtagListItem {
  tag: string;
  isNew?: boolean;
}

interface Props {
  items: HashtagListItem[];
  command: (item: HashtagListItem) => void;
}

export interface HashtagListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const HashtagList = forwardRef<HashtagListHandle, Props>(function HashtagList(
  { items, command },
  ref,
) {
  const [selected, setSelected] = useState(0);

  useEffect(() => setSelected(0), [items]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) return false;
      if (event.key === "ArrowUp") {
        setSelected((s) => (s + items.length - 1) % items.length);
        return true;
      }
      if (event.key === "ArrowDown") {
        setSelected((s) => (s + 1) % items.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        command(items[selected]);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="px-2 py-1 text-xs text-neutral-500 italic">No matches.</div>
    );
  }

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1 min-w-[140px] max-h-60 overflow-y-auto">
      {items.map((item, i) => (
        <button
          key={item.tag}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
          className={`w-full text-left px-2 py-1 text-sm font-mono ${
            i === selected
              ? "bg-blue-500 text-white"
              : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          #{item.tag}
          {item.isNew && (
            <span className="ml-2 text-[10px] opacity-70">(new)</span>
          )}
        </button>
      ))}
    </div>
  );
});

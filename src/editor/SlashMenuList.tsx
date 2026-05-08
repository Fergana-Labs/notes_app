import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface SlashMenuItem {
  id: string;
  label: string;
  description: string;
  icon: ReactNode;
  shortcut?: string;
  keywords: string[];
  run: (ctx: SlashMenuRunContext) => void;
}

export interface SlashMenuRunContext {
  range: { from: number; to: number };
}

interface Props {
  items: SlashMenuItem[];
  command: (item: SlashMenuItem) => void;
}

export interface SlashMenuListHandle {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

export const SlashMenuList = forwardRef<SlashMenuListHandle, Props>(function SlashMenuList(
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
      <div className="px-3 py-2 text-xs text-neutral-500 italic">No matches.</div>
    );
  }

  return (
    <div className="rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1 w-[260px] max-h-72 overflow-y-auto">
      {items.map((item, i) => (
        <button
          key={item.id}
          onMouseEnter={() => setSelected(i)}
          onClick={() => command(item)}
          className={`w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm ${
            i === selected
              ? "bg-blue-500 text-white"
              : "hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
          }`}
        >
          <span
            className={`shrink-0 w-7 h-7 rounded flex items-center justify-center ${
              i === selected
                ? "bg-white/20 text-white"
                : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300"
            }`}
          >
            {item.icon}
          </span>
          <span className="flex-1 min-w-0">
            <span className="block font-medium truncate">{item.label}</span>
            <span
              className={`block text-[11px] truncate ${
                i === selected ? "text-white/80" : "text-neutral-500"
              }`}
            >
              {item.description}
            </span>
          </span>
          {item.shortcut && (
            <span
              className={`shrink-0 font-mono text-[10px] ${
                i === selected ? "text-white/70" : "text-neutral-400"
              }`}
            >
              {item.shortcut}
            </span>
          )}
        </button>
      ))}
    </div>
  );
});

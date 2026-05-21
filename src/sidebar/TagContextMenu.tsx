import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import type { TagCount } from "../lib/ipc";

interface Props {
  tag: TagCount;
  x: number;
  y: number;
  onClose: () => void;
  onEditDescription: () => void;
  onDelete: () => void;
}

/**
 * Right-click context menu for a tag. Anchored at the click point
 * (clamped to viewport). Closes on outside-click or Escape.
 */
export function TagContextMenu({
  tag,
  x,
  y,
  onClose,
  onEditDescription,
  onDelete,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = y;
    let left = x;
    if (left + rect.width > vw - margin) left = vw - rect.width - margin;
    if (top + rect.height > vh - margin) top = vh - rect.height - margin;
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    setPos({ top, left });
  }, [x, y]);

  return (
    <div
      ref={ref}
      style={
        pos
          ? { position: "fixed", top: pos.top, left: pos.left }
          : { position: "fixed", visibility: "hidden" }
      }
      className="z-50 w-52 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1 text-sm"
    >
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-400">
        #{tag.tag}
      </div>
      <Item icon={<Pencil size={13} />} onClick={onEditDescription}>
        Edit description…
      </Item>
      <Item icon={<Trash2 size={13} />} onClick={onDelete} danger>
        Delete tag…
      </Item>
    </div>
  );
}

function Item({
  children,
  icon,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left ${
        danger
          ? "text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

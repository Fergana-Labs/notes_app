import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Trash2,
  Copy,
  ClipboardCopy,
  History,
  ArrowUpToLine,
  ChevronRight,
  Type as TypeIcon,
  SplitSquareVertical,
} from "lucide-react";
import { BLOCK_TYPES } from "./blockTypes";
import type { Editor } from "@tiptap/core";
import type { StoredBlock } from "../lib/ipc";

interface Props {
  block: StoredBlock;
  editor: Editor | null;
  isFirst: boolean;
  anchorRect: DOMRect | null;
  /** Whether the underlying mochiBlock has more than one block-level child. */
  canSplitIntoBlocks: boolean;
  activeBlockTypeId: string;
  onClose: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onTurnInto: (typeId: string) => void;
  onMergeUp: () => void;
  onShowHistory: () => void;
  onCopyMarkdown: () => void;
  onCopyId: () => void;
  onSplitIntoBlocks: () => void;
  onSplitAtCursor: () => void;
}

export function BlockMenu({
  block,
  editor,
  isFirst,
  anchorRect,
  canSplitIntoBlocks,
  activeBlockTypeId,
  onClose,
  onDelete,
  onDuplicate,
  onTurnInto,
  onMergeUp,
  onShowHistory,
  onCopyMarkdown,
  onCopyId,
  onSplitIntoBlocks,
  onSplitAtCursor,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const turnIntoRef = useRef<HTMLDivElement>(null);
  const [showTurnInto, setShowTurnInto] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // Whether the Turn Into submenu should open to the LEFT of its parent
  // row (instead of the default right). Set when the right-side opening
  // would clip off the viewport — same pattern as the parent-menu flip
  // below, but local to the submenu.
  const [turnIntoFlipLeft, setTurnIntoFlipLeft] = useState(false);

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

  // Position the menu so it stays inside the viewport. Runs synchronously
  // before paint so there's no flicker.
  useLayoutEffect(() => {
    if (!anchorRect || !ref.current) return;
    const menuRect = ref.current.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = anchorRect.bottom + 4;
    let left = anchorRect.left;

    if (top + menuRect.height > vh - margin) {
      // Flip above the anchor.
      top = anchorRect.top - menuRect.height - 4;
      // If still off-screen at the top, just snap to viewport top.
      if (top < margin) top = Math.max(margin, vh - menuRect.height - margin);
    }
    if (left + menuRect.width > vw - margin) {
      left = vw - menuRect.width - margin;
    }
    if (left < margin) left = margin;

    setPos({ top, left });
  }, [anchorRect]);

  // After the Turn Into submenu opens, measure where the right edge
  // would land and flip to the left side if it would clip off-screen.
  useLayoutEffect(() => {
    if (!showTurnInto) return;
    const parentRect = ref.current?.getBoundingClientRect();
    const sub = turnIntoRef.current;
    if (!parentRect || !sub) return;
    const subWidth = sub.getBoundingClientRect().width;
    const margin = 8;
    const wouldOverflow =
      parentRect.right + subWidth + margin > window.innerWidth;
    setTurnIntoFlipLeft(wouldOverflow);
  }, [showTurnInto, pos]);

  if (!anchorRect) return null;

  const style: React.CSSProperties = {
    position: "fixed",
    top: pos?.top ?? -9999,
    left: pos?.left ?? -9999,
    zIndex: 60,
    visibility: pos ? "visible" : "hidden",
  };

  const fmt = (ts: number) => new Date(ts).toLocaleString();

  return (
    <div
      ref={ref}
      style={style}
      className="w-56 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl py-1 text-sm"
    >
      <div className="relative">
        <button
          onClick={() => setShowTurnInto((v) => !v)}
          onMouseEnter={() => setShowTurnInto(true)}
          className="w-full flex items-center justify-between px-2 py-1.5 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <span className="flex items-center gap-2">
            <TypeIcon size={14} />
            Turn into
          </span>
          <ChevronRight size={12} />
        </button>
        {showTurnInto && editor && (
          <div
            ref={turnIntoRef}
            onMouseLeave={() => setShowTurnInto(false)}
            className={`absolute top-0 w-48 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl py-1 ${
              turnIntoFlipLeft ? "right-full mr-1" : "left-full ml-1"
            }`}
          >
            {BLOCK_TYPES.map((b) => {
              const active = b.id === activeBlockTypeId;
              return (
                <button
                  key={b.id}
                  onClick={() => {
                    onTurnInto(b.id);
                    onClose();
                  }}
                  className={`w-full flex items-center gap-2 px-2 py-1 text-left ${
                    active
                      ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                  }`}
                >
                  <b.icon size={13} className="shrink-0" />
                  <span className="truncate">{b.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <Item
        icon={<SplitSquareVertical size={14} />}
        label="Split here"
        shortcut="⌘↵"
        onClick={() => {
          onSplitAtCursor();
          onClose();
        }}
      />
      {canSplitIntoBlocks && (
        <Item
          icon={<SplitSquareVertical size={14} />}
          label="Split into separate blocks"
          onClick={() => {
            onSplitIntoBlocks();
            onClose();
          }}
        />
      )}

      <Divider />

      <Item icon={<Copy size={14} />} label="Duplicate" onClick={() => { onDuplicate(); onClose(); }} />
      <Item icon={<ClipboardCopy size={14} />} label="Copy as markdown" onClick={() => { onCopyMarkdown(); onClose(); }} />
      <Item icon={<ClipboardCopy size={14} />} label="Copy block ID" onClick={() => { onCopyId(); onClose(); }} />
      <Item icon={<History size={14} />} label="History" onClick={() => { onShowHistory(); onClose(); }} />
      {!isFirst && (
        <Item
          icon={<ArrowUpToLine size={14} />}
          label="Merge into above"
          shortcut="⌘⌫"
          onClick={() => { onMergeUp(); onClose(); }}
        />
      )}
      <Divider />
      <Item
        icon={<Trash2 size={14} />}
        label="Delete"
        danger
        onClick={() => { onDelete(); onClose(); }}
      />

      <Divider />
      <div className="px-2 py-1.5 text-[10px] text-neutral-500 font-mono leading-tight">
        <div>{fmt(block.updated_at)}</div>
        <div className="opacity-70">{block.id}</div>
        {block.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {block.tags.map((t) => (
              <span
                key={t}
                className="px-1 rounded bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Item({
  icon,
  label,
  shortcut,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center justify-between px-2 py-1.5 ${
        danger
          ? "text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      <span className="flex items-center gap-2">
        {icon}
        {label}
      </span>
      {shortcut && (
        <span className="text-[10px] font-mono text-neutral-400">{shortcut}</span>
      )}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />;
}

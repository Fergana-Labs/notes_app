import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { ipc, type TagCount } from "../lib/ipc";

interface Props {
  tag: TagCount;
  onClose: () => void;
  onConfirmed: () => void;
}

/**
 * Modal: delete a tag with two semantics. "Strip" detaches the tag
 * from every block it's on (blocks stay, content untouched — tags
 * live in their own table now, not in block content). "Delete blocks"
 * removes every block that carries the tag. Both also drop the
 * tag's row from the `tags` table.
 */
export function TagDeleteModal({ tag, onClose, onConfirmed }: Props) {
  const [pending, setPending] = useState<"strip" | "delete_blocks" | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  const run = async (mode: "strip" | "delete_blocks") => {
    setPending(mode);
    try {
      await ipc.deleteTag(tag.tag, mode);
      onConfirmed();
    } finally {
      setPending(null);
    }
  };

  // Portal to body so the Sidebar's `backdrop-blur` containing block
  // doesn't clamp the overlay to the sidebar width.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={() => !pending && onClose()}
    >
      <div
        className="w-[min(520px,90vw)] rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-base font-semibold">
            Delete <span className="font-mono">#{tag.tag}</span>
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            This tag is on {tag.count} block{tag.count === 1 ? "" : "s"}. Pick
            what should happen to them.
          </p>
        </div>

        <div className="px-4 pb-4 grid gap-2">
          <ActionCard
            title={`Remove tag from ${tag.count} block${tag.count === 1 ? "" : "s"}`}
            desc="Blocks keep their content unchanged; the tag is simply detached from each of them. The tag is removed from the workspace."
            cta="Remove tag"
            disabled={pending !== null}
            loading={pending === "strip"}
            onClick={() => run("strip")}
          />
          <ActionCard
            title={`Delete ${tag.count} block${tag.count === 1 ? "" : "s"}`}
            desc="Every block tagged with this is removed from the canvas. ⌘Z undoes only the last bulk action — be sure."
            cta="Delete blocks"
            destructive
            disabled={pending !== null}
            loading={pending === "delete_blocks"}
            onClick={() => run("delete_blocks")}
          />
        </div>

        <div className="flex items-center justify-end px-4 py-3 border-t border-neutral-100 dark:border-neutral-800">
          <button
            onClick={onClose}
            disabled={pending !== null}
            className="text-sm px-3 py-1.5 rounded text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ActionCard({
  title,
  desc,
  cta,
  destructive,
  disabled,
  loading,
  onClick,
}: {
  title: string;
  desc: string;
  cta: string;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        destructive
          ? "border-red-200 dark:border-red-900/50"
          : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <div className="font-medium text-sm">{title}</div>
      <div className="text-xs text-neutral-500 mt-1">{desc}</div>
      <div className="mt-2 flex justify-end">
        <button
          onClick={onClick}
          disabled={disabled}
          className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${
            destructive
              ? "bg-red-600 hover:bg-red-700 text-white"
              : "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90"
          } disabled:opacity-50`}
        >
          <Trash2 size={13} />
          {loading ? "Working…" : cta}
        </button>
      </div>
    </div>
  );
}

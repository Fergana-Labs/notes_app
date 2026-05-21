import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipc, type TagCount } from "../lib/ipc";

interface Props {
  tag: TagCount;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Modal: edit the user-visible description for a tag. Persists via
 * `ipc.setTagDescription`. Empty string is a valid "clear the
 * description" value.
 */
export function TagDescriptionModal({ tag, onClose, onSaved }: Props) {
  const [text, setText] = useState(tag.description);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    try {
      await ipc.setTagDescription(tag.tag, text);
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  // Portal to document.body so the Sidebar's `backdrop-blur` doesn't
  // create a containing block that clamps `position: fixed` to the
  // sidebar's width. (CSS spec: backdrop-filter establishes a containing
  // block for fixed descendants.)
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-[min(480px,90vw)] rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-base font-semibold">
            Description for <span className="font-mono">#{tag.tag}</span>
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Shown on hover and in the tag chip tooltip. Helps future-you
            remember why this tag exists.
          </p>
        </div>
        <div className="px-4 pb-3">
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            className="w-full p-2 text-sm rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none focus:border-blue-400 dark:focus:border-blue-600"
            placeholder="What's this tag for?"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
          />
          <p className="text-[11px] text-neutral-400 mt-1">
            ⌘↵ to save · Esc to cancel
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-neutral-100 dark:border-neutral-800">
          <button
            onClick={onClose}
            className="text-sm px-3 py-1.5 rounded text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="text-sm px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

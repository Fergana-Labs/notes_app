import type { Editor } from "@tiptap/core";

/**
 * Module-level reference to the Tiptap editor the user is currently
 * working in — the most-recently focused per-card / fullscreen editor.
 * Cmd-F's "find in note" binds to this so it can highlight + navigate
 * matches in the note the user is actually in, without prop-drilling a
 * registry through the virtualized feed.
 *
 * Subscribers (the find bar) are notified when it changes so they can
 * re-bind / close as the user moves between cards.
 */
let activeEditor: Editor | null = null;
const subscribers = new Set<(e: Editor | null) => void>();

export const setActiveEditor = (e: Editor | null) => {
  if (activeEditor === e) return;
  activeEditor = e;
  for (const fn of subscribers) fn(e);
};

/** Clear only if `e` is still the active editor (avoids a late blur from
 *  an old card stomping a newer card's focus). */
export const clearActiveEditorIf = (e: Editor | null) => {
  if (activeEditor === e) setActiveEditor(null);
};

export const getActiveEditor = () => activeEditor;

export const subscribeActiveEditor = (fn: (e: Editor | null) => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};

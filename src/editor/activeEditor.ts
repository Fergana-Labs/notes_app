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

// ── Cross-window focus restoration ──────────────────────────────────────
// Switching to another app blurs the webview, dropping the editor's DOM
// focus + selection; the browser doesn't restore them on return. We
// remember the last focused editor and its caret so we can put the user
// back exactly where they were typing. Unlike `activeEditor`, this is NOT
// cleared on blur — only replaced when a different editor takes focus.
let lastFocused: Editor | null = null;
let lastSelection: { from: number; to: number } | null = null;

export const rememberFocus = (e: Editor) => {
  lastFocused = e;
  lastSelection = { from: e.state.selection.from, to: e.state.selection.to };
};

export const rememberSelection = (e: Editor) => {
  if (lastFocused === e) {
    lastSelection = { from: e.state.selection.from, to: e.state.selection.to };
  }
};

/** Put focus + caret back where the user last was. Called when the OS
 *  window regains focus and nothing else in the app is focused. */
export const restoreLastFocus = () => {
  const e = lastFocused;
  if (!e || e.isDestroyed) return;
  try {
    const sel = lastSelection;
    if (sel) {
      const size = e.state.doc.content.size;
      const from = Math.min(sel.from, size);
      const to = Math.min(sel.to, size);
      e.commands.setTextSelection({ from, to });
    }
    e.commands.focus();
  } catch {
    /* editor may have been torn down between blur and refocus */
  }
};

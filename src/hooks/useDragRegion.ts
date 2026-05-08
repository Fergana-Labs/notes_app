import { useEffect, type RefObject } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const INTERACTIVE_SELECTOR =
  "input, button, textarea, a, select, label, [contenteditable=true]";

/**
 * Make the element under `ref` a window drag region — clicks on the empty
 * parts of it drag the OS window; double-click toggles maximize. Clicks on
 * interactive descendants (inputs, buttons, links, etc.) pass through
 * normally.
 *
 * We use this in addition to (or instead of) the `data-tauri-drag-region`
 * attribute, which has been unreliable depending on the WebView state.
 * Calling `startDragging()` directly via the Tauri window API always works.
 */
export function useDragRegion(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onMouseDown = async (e: MouseEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(INTERACTIVE_SELECTOR)) return;
      // Don't start dragging if a text selection is in progress.
      if (window.getSelection()?.toString()) return;
      try {
        const win = getCurrentWindow();
        if (e.detail === 2) {
          await win.toggleMaximize();
        } else {
          await win.startDragging();
        }
      } catch {
        // Tauri API not available (e.g. running outside the desktop app).
      }
    };
    el.addEventListener("mousedown", onMouseDown);
    return () => el.removeEventListener("mousedown", onMouseDown);
  }, [ref]);
}

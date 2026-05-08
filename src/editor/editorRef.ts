import type { Editor } from "@tiptap/core";

/**
 * Module-level reference to the canvas Tiptap editor. Used by the sidebar
 * (Sections drag, search jump-to-block) so it can dispatch transactions on the
 * single source-of-truth editor instance without prop-drilling.
 */
let canvasEditor: Editor | null = null;

export const setCanvasEditor = (e: Editor | null) => {
  canvasEditor = e;
};

export const getCanvasEditor = () => canvasEditor;

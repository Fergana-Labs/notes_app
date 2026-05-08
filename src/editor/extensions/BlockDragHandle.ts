import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const dragKey = new PluginKey("mochiBlockDrag");

/**
 * Pointer-driven drag-and-drop for mochiBlocks.
 *
 * Critically, this implementation does **not** dispatch ProseMirror
 * transactions during the drag (no decorations, no setMeta) — that triggers
 * React NodeView re-renders, which were breaking pointer capture and eating
 * `pointerup` events. Visual feedback during the drag is done with direct
 * DOM manipulation:
 *   - the source block gets a `mochi-block-dragging` class on its DOM,
 *   - a floating `<div>` rendered into `document.body` shows the drop line,
 *   - the cursor + body class are toggled on `document.body`.
 *
 * Only the final drop is committed as a single PM transaction (so it's one
 * undo step).
 *
 * Events are listened on `window` so they fire regardless of where the
 * cursor ends up or whether the original handle DOM has been replaced.
 */
export const BlockDragHandle = Extension.create({
  name: "mochiBlockDragHandle",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: dragKey,
        view(editorView) {
          return new DragController(editorView);
        },
      }),
    ];
  },
});

type Mode =
  | { kind: "idle" }
  | {
      kind: "armed";
      sourcePos: number;
      sourceNode: PMNode;
      sourceDom: HTMLElement;
      startX: number;
      startY: number;
      pointerId: number;
    }
  | {
      kind: "dragging";
      sourcePos: number;
      sourceNode: PMNode;
      sourceDom: HTMLElement;
      pointerId: number;
    };

class DragController {
  private view: EditorView;
  private mode: Mode = { kind: "idle" };
  private dropLineEl: HTMLDivElement | null = null;

  private onPointerDown = (e: PointerEvent) => this.handlePointerDown(e);
  private onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);
  private onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);

  constructor(view: EditorView) {
    this.view = view;
    view.dom.addEventListener("pointerdown", this.onPointerDown);
    // Wipe any lingering DOM state from a previous instance (e.g. an HMR
    // reload or a failed drag in a prior session).
    scrubGlobalDragState();
  }

  private handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    if (e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;

    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (!target.closest?.("[data-drag-handle]")) return;

    // Belt-and-suspenders: wipe any DOM artifacts that might've leaked from a
    // previous drag (stuck class, lingering drop-line element). Cheap and
    // makes every drag start from a clean slate.
    scrubGlobalDragState();

    const blockEl = target.closest?.("[data-block-id]") as HTMLElement | null;
    if (!blockEl) return;

    const id = blockEl.dataset.blockId ?? "";
    let sourcePos = -1;
    let sourceNode: PMNode | null = null;
    this.view.state.doc.forEach((node, offset) => {
      if (
        node.type.name === "mochiBlock" &&
        (node.attrs.id ?? "") === id &&
        sourcePos < 0
      ) {
        sourcePos = offset;
        sourceNode = node;
      }
    });
    if (sourcePos < 0 || !sourceNode) return;

    // Recover from any leftover state from a prior failed drag.
    if (this.mode.kind !== "idle") this.fullCleanup();

    // Hint: capture pointer so cursor stays grabbing across the page. Window
    // listeners (below) catch the events regardless.
    try {
      blockEl.setPointerCapture?.(e.pointerId);
    } catch {
      // ignore
    }

    this.mode = {
      kind: "armed",
      sourcePos,
      sourceNode,
      sourceDom: blockEl,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
    };

    // Window listeners — fire reliably regardless of React unmount / where the
    // cursor ends up. (We deliberately don't listen for `blur` here — element
    // blur events bubble up and would prematurely terminate the drag.)
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("pointercancel", this.onPointerUp, true);
    // mouseup as a fallback in case pointerup is suppressed in some path.
    window.addEventListener("mouseup", this.onPointerUp as any, true);
    document.addEventListener("keydown", this.onKeyDown, true);
  }

  private handlePointerMove(e: PointerEvent) {
    if (this.mode.kind === "idle") return;

    if (this.mode.kind === "armed") {
      const dx = e.clientX - this.mode.startX;
      const dy = e.clientY - this.mode.startY;
      if (Math.hypot(dx, dy) < 4) return;

      const { sourcePos, sourceNode, sourceDom, pointerId } = this.mode;
      this.mode = { kind: "dragging", sourcePos, sourceNode, sourceDom, pointerId };
      sourceDom.classList.add("mochi-block-dragging");
      document.body.style.cursor = "grabbing";
      document.body.classList.add("mochi-dragging");
    }

    if (this.mode.kind === "dragging") {
      this.updateDropLine(e);
      e.preventDefault();
    }
  }

  private handlePointerUp(e: Event) {
    const m = this.mode;
    if (m.kind !== "dragging") {
      this.fullCleanup();
      return;
    }

    // Compute drop pos before cleanup tears down the line.
    const pe = (e as PointerEvent).clientX != null ? (e as PointerEvent) : null;
    const dropPos = pe ? this.computeDropPos(pe) : null;

    this.fullCleanup();

    if (
      dropPos == null ||
      dropPos === m.sourcePos ||
      dropPos === m.sourcePos + m.sourceNode.nodeSize
    ) {
      return; // no-op
    }

    let tr = this.view.state.tr.delete(
      m.sourcePos,
      m.sourcePos + m.sourceNode.nodeSize,
    );
    const mappedDrop = tr.mapping.map(dropPos, -1);
    tr = tr.insert(mappedDrop, m.sourceNode);
    this.view.dispatch(tr);
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape") return;
    if (this.mode.kind === "idle") return;
    this.fullCleanup();
  }

  /** Idempotent. Called from any drag-end path. */
  private fullCleanup() {
    const m = this.mode;
    if (m.kind !== "idle") {
      try {
        if (
          m.sourceDom &&
          (m.sourceDom as Element).hasPointerCapture?.(m.pointerId)
        ) {
          (m.sourceDom as Element).releasePointerCapture(m.pointerId);
        }
      } catch {
        // ignore
      }
    }
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("pointercancel", this.onPointerUp, true);
    window.removeEventListener("mouseup", this.onPointerUp as any, true);
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.removeDropLine();
    scrubGlobalDragState();
    this.mode = { kind: "idle" };
  }

  private updateDropLine(e: PointerEvent) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const overEl = target
      ? ((target as Element).closest("[data-block-id]") as HTMLElement | null)
      : null;

    let lineY: number | null = null;
    let lineLeft = 0;
    let lineWidth = 0;

    if (overEl) {
      const rect = overEl.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      lineY = after ? rect.bottom : rect.top;
      lineLeft = rect.left;
      lineWidth = rect.width;
    } else {
      // No block under cursor: snap to top or bottom of editor.
      const editorRect = this.view.dom.getBoundingClientRect();
      if (e.clientY < editorRect.top + 8) {
        lineY = editorRect.top;
      } else if (e.clientY > editorRect.bottom - 8) {
        lineY = editorRect.bottom;
      }
      lineLeft = editorRect.left;
      lineWidth = editorRect.width;
    }

    if (lineY == null) {
      this.removeDropLine();
      return;
    }
    if (!this.dropLineEl) {
      this.dropLineEl = document.createElement("div");
      this.dropLineEl.className = "mochi-drop-line-floating";
      document.body.appendChild(this.dropLineEl);
    }
    this.dropLineEl.style.top = `${lineY - 1.5}px`;
    this.dropLineEl.style.left = `${lineLeft}px`;
    this.dropLineEl.style.width = `${lineWidth}px`;
  }

  private removeDropLine() {
    this.dropLineEl?.remove();
    this.dropLineEl = null;
  }

  private computeDropPos(e: PointerEvent): number | null {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const blockEl = target
      ? ((target as Element).closest("[data-block-id]") as HTMLElement | null)
      : null;

    if (blockEl) {
      const id = blockEl.dataset.blockId ?? "";
      let blockPos = -1;
      let blockNode: PMNode | null = null;
      this.view.state.doc.forEach((node, offset) => {
        if (
          node.type.name === "mochiBlock" &&
          (node.attrs.id ?? "") === id &&
          blockPos < 0
        ) {
          blockPos = offset;
          blockNode = node;
        }
      });
      if (blockPos < 0 || !blockNode) return null;
      const rect = blockEl.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      return after ? blockPos + (blockNode as PMNode).nodeSize : blockPos;
    }

    const editorRect = this.view.dom.getBoundingClientRect();
    if (e.clientY < editorRect.top + 8) return 0;
    if (e.clientY > editorRect.bottom - 8) return this.view.state.doc.content.size;
    return null;
  }

  destroy() {
    this.view.dom.removeEventListener("pointerdown", this.onPointerDown);
    this.fullCleanup();
  }
}

/**
 * Removes any DOM state we might've created (in this or a prior plugin
 * instance / HMR cycle): the `mochi-block-dragging` class on any block, any
 * floating drop-line elements, the body's drag class, and the body cursor.
 */
function scrubGlobalDragState() {
  document
    .querySelectorAll(".mochi-block-dragging")
    .forEach((el) => el.classList.remove("mochi-block-dragging"));
  document
    .querySelectorAll(".mochi-drop-line-floating")
    .forEach((el) => el.remove());
  document.body.classList.remove("mochi-dragging");
  document.body.style.cursor = "";
}

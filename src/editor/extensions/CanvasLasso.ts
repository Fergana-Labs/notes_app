import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const lassoKey = new PluginKey("mochiLasso");

interface LassoState {
  rect: { x: number; y: number; w: number; h: number } | null;
}

/**
 * Click-and-drag from the empty canvas area (outside any block) to lasso-select
 * a contiguous span of mochiBlocks. The selection lands as a regular
 * `TextSelection` covering the chosen blocks, so Cmd-C / Backspace / etc. all
 * work natively.
 *
 * A plain click (without drag) on empty canvas just focuses the editor at the
 * end — feels like a canvas.
 */
export const CanvasLasso = Extension.create({
  name: "mochiCanvasLasso",

  addProseMirrorPlugins() {
    return [
      new Plugin<LassoState>({
        key: lassoKey,
        state: {
          init: () => ({ rect: null }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(lassoKey);
            if (!meta) return prev;
            return meta;
          },
        },
        props: {
          decorations(state) {
            const s = lassoKey.getState(state);
            if (!s?.rect) return null;
            const r = s.rect;
            const widget = document.createElement("div");
            widget.className =
              "fixed pointer-events-none border border-blue-400 bg-blue-200/20 dark:border-blue-500 dark:bg-blue-500/15 z-30 rounded-sm";
            widget.style.left = `${r.x}px`;
            widget.style.top = `${r.y}px`;
            widget.style.width = `${r.w}px`;
            widget.style.height = `${r.h}px`;
            return DecorationSet.create(state.doc, [
              Decoration.widget(0, widget, { side: -1 }),
            ]);
          },
          handleDOMEvents: {
            mousedown(view, event) {
              const target = event.target as HTMLElement;
              if (!target) return false;
              // Only fire when mousedown is on the editor wrapper itself or
              // outside any block — so clicks inside text are unaffected.
              if (target.closest("[data-block-id]")) return false;
              if (event.button !== 0) return false;

              const startX = event.clientX;
              const startY = event.clientY;
              let isDrag = false;

              const onMove = (mv: MouseEvent) => {
                const dx = mv.clientX - startX;
                const dy = mv.clientY - startY;
                if (!isDrag && Math.hypot(dx, dy) > 4) {
                  isDrag = true;
                }
                if (!isDrag) return;
                const x = Math.min(startX, mv.clientX);
                const y = Math.min(startY, mv.clientY);
                const w = Math.abs(mv.clientX - startX);
                const h = Math.abs(mv.clientY - startY);
                view.dispatch(
                  view.state.tr.setMeta(lassoKey, { rect: { x, y, w, h } }),
                );

                // Compute which mochiBlocks intersect the lasso vertically.
                const docEl = view.dom;
                const blockEls = Array.from(
                  docEl.querySelectorAll("[data-block-id]"),
                ) as HTMLElement[];
                let firstPos: number | null = null;
                let lastPos: number | null = null;
                for (const el of blockEls) {
                  const rect = el.getBoundingClientRect();
                  const intersects =
                    rect.bottom >= y && rect.top <= y + h;
                  if (!intersects) continue;
                  const pos = view.posAtDOM(el, 0);
                  if (pos == null || pos < 0) continue;
                  // Resolve the surrounding mochiBlock node and its bounds.
                  const $pos = view.state.doc.resolve(pos);
                  for (let d = $pos.depth; d > 0; d--) {
                    if ($pos.node(d).type.name === "mochiBlock") {
                      const start = $pos.before(d);
                      const end = $pos.after(d);
                      if (firstPos === null) firstPos = start + 1;
                      lastPos = end - 1;
                      break;
                    }
                  }
                }

                if (firstPos != null && lastPos != null && lastPos >= firstPos) {
                  const sel = TextSelection.create(
                    view.state.doc,
                    firstPos,
                    lastPos,
                  );
                  view.dispatch(view.state.tr.setSelection(sel));
                }
              };

              const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                view.dispatch(
                  view.state.tr.setMeta(lassoKey, { rect: null }),
                );
                if (!isDrag) {
                  // Plain click on empty canvas → focus end of doc.
                  const end = view.state.doc.content.size;
                  view.dispatch(
                    view.state.tr.setSelection(
                      TextSelection.create(view.state.doc, end - 1, end - 1),
                    ),
                  );
                  view.focus();
                }
              };
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
              return true;
            },
          },
        },
      }),
    ];
  },
});

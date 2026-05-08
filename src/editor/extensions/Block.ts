import { Node, cancelPositionCheck, mergeAttributes } from "@tiptap/core";
import { ReactNodeView, ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import { ulid } from "ulid";
import { BlockView } from "../BlockView";

// One-time monkey-patch of `ReactNodeView.prototype.mount` to neutralise
// the per-NodeView `schedulePositionCheck` registration.
//
// Why this can't live in the addNodeView wrapper:
//   `ReactNodeView`'s constructor sets `this.positionCheckCallback = null`
//   as a class-field initialiser. In ES class semantics, class fields run
//   AFTER `super()` returns. The `NodeView` base constructor calls
//   `this.mount()` (the overridden ReactNodeView.mount), which assigns
//   `this.positionCheckCallback = () => {...}` and registers it with the
//   per-editor registry. When super() returns, the `= null` field
//   initialiser fires and clobbers the reference back to null — even
//   though the registry still holds the function. By the time our
//   addNodeView wrapper runs, `nodeView.positionCheckCallback` is null
//   and the cancel-by-reference path is a silent no-op, leaving 2k
//   callbacks alive in the registry. The rAF that fires those callbacks
//   then calls `getPos()` (an O(N) sibling-array scan) on every block
//   for every editor `update`, ≈ O(N²) per keystroke and ≈ 535ms per
//   frame on a 2k-block doc — exactly what the WebKit Inspector
//   timeline showed. Cancelling inside `mount` runs *before* the field
//   initialiser, so the registry actually empties out.
//
// Done as a side-effect at module load (idempotent — guarded against
// re-application during HMR).
const RNV_MOUNT_PATCHED = Symbol.for("mochi.rnvMountPatched");
const proto = ReactNodeView.prototype as any;
if (!proto[RNV_MOUNT_PATCHED]) {
  const origMount = proto.mount;
  proto.mount = function patchedMount(this: any) {
    origMount.call(this);
    const cb = this.positionCheckCallback;
    if (cb && this.editor) {
      cancelPositionCheck(this.editor, cb);
      // Setting to null here is fine — the constructor's class field
      // is going to overwrite this anyway. We just unhook from the
      // registry before any update event has a chance to fire it.
      this.positionCheckCallback = null;
    }
  };
  proto[RNV_MOUNT_PATCHED] = true;
}

/** Element-wise equality on PM decoration arrays — avoids spurious React
 *  re-renders. Most blocks have an empty array, so this hits length === 0
 *  and returns true in O(1). */
function decorationsArrayEq(
  a: readonly Decoration[],
  b: readonly Decoration[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

const idMintKey = new PluginKey("mochiBlockIdMint");

/**
 * The custom `mochiBlock` node — top-level container for every visible block in
 * the canvas. Its inner content is exactly one block-level node (heading,
 * paragraph, list, code-block, blockquote, etc.). Attributes on this node hold
 * Mochi-specific metadata (id, tags) that travel with the block as it's
 * dragged, split, copied, etc.
 *
 * The schema is set up so that `doc.content = mochiBlock+`, which means every
 * top-level child of the document is a mochiBlock. This is enforced by a custom
 * Document extension defined alongside this one (see Document.ts).
 */
export const Block = Node.create({
  name: "mochiBlock",
  group: "mochiBlock",
  // Allow multiple block-level children per mochiBlock so Enter inside a
  // paragraph can create a sibling paragraph, and Backspace can lift out of
  // a list (both fail schema-wise with a single-child rule). The on-disk
  // form is unchanged — a multi-content block is still one `<!-- block:ID -->`
  // entry in canvas.md.
  content: "block+",
  defining: true,
  isolating: false,
  selectable: true,
  // We do NOT set `draggable: true`. With it, Tiptap sets `dom.draggable=true`
  // on the wrapper, which makes the browser race an HTML5 drag against our
  // pointer-event drag (you'd see the green-plus / no-drop cursor and
  // ghosts). The custom `BlockDragHandle` plugin handles drag-and-drop
  // entirely via pointer events.
  draggable: false,

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-block-id"),
        renderHTML: (attrs) =>
          attrs.id ? { "data-block-id": attrs.id } : {},
      },
      tags: {
        default: [] as string[],
        parseHTML: (el) => {
          const raw = el.getAttribute("data-tags");
          if (!raw) return [];
          try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
          } catch {
            return [];
          }
        },
        renderHTML: (attrs) =>
          Array.isArray(attrs.tags) && attrs.tags.length > 0
            ? { "data-tags": JSON.stringify(attrs.tags) }
            : {},
      },
      manualTags: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-manual-tags") === "true",
        renderHTML: (attrs) =>
          attrs.manualTags ? { "data-manual-tags": "true" } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-block-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes({ class: "mochi-block" }, HTMLAttributes),
      0,
    ];
  },

  addNodeView() {
    // Custom `update` short-circuits the React re-render path for blocks
    // whose underlying PM node and decorations didn't actually change.
    // Without this, Tiptap calls `updateProps()` on every NodeView for
    // every transaction (because PM regenerates the per-node decorations
    // array each time), producing 2k React-root render attempts per
    // keystroke on large docs.
    const factory = ReactNodeViewRenderer(BlockView, {
      update: ({ oldNode, newNode, oldDecorations, newDecorations, updateProps }) => {
        if (
          oldNode === newNode &&
          decorationsArrayEq(
            oldDecorations as readonly Decoration[],
            newDecorations as readonly Decoration[],
          )
        ) {
          // Returning `true` here keeps the existing NodeView without
          // touching React.
          return true;
        }
        // Typing inside a block produces a new mochiBlock node ref (PM
        // nodes are immutable), but the React `BlockView` component only
        // depends on:
        //   - node.attrs (id, tags, manualTags)
        //   - first-child type/level (gutter-padding choice for headings)
        //   - decorations (the outer-decoration array)
        // The actual editable text is rendered into `contentDOM` directly
        // by PM, *not* through React. So when only the inner text changed,
        // calling `updateProps` is pure waste — and it's the dominant
        // remaining keystroke cost on a 2k-block doc, because Tiptap's
        // ReactRenderer.setRenderer notifies a portal subscriber that
        // re-reconciles all N portal entries on every change.
        // PM's `Node.copy` preserves `attrs` and `marks` references when
        // only content changes, so reference equality is sufficient.
        const oldFirst = oldNode.firstChild;
        const newFirst = newNode.firstChild;
        if (
          oldNode.attrs === newNode.attrs &&
          oldFirst?.type === newFirst?.type &&
          (oldFirst?.attrs.level ?? null) === (newFirst?.attrs.level ?? null)
        ) {
          return true;
        }
        updateProps();
        return true;
      },
    });
    // Tiptap's ReactNodeView schedules a per-NodeView "position check"
    // callback that runs on every editor `update` event. Each callback
    // calls `renderer.updateProps({ getPos })` whenever its block's
    // position changed — and `updateProps` rebuilds the editor's portal
    // renderers map via `{ ...renderers, [id]: portal }`. With N=2k blocks
    // and a keystroke that shifts ~N/2 of them, that becomes O(N²) per
    // keystroke (≈4M ops) and is the main remaining source of typing lag.
    //
    // BlockView only reads `getPos` inside click handlers, never during
    // render, so the prop refresh is wasted work. PM's underlying
    // `getPos` closure resolves the live position at call time, so click
    // handlers stay correct.
    return (props: any) => {
      const nodeView: any = factory(props);
      // The prototype-`mount` patch above already cancelled the
      // schedulePositionCheck registration before the class-field
      // initialiser clobbered `nodeView.positionCheckCallback`. This
      // remains as a safety net in case the patch hasn't applied yet
      // (e.g. during HMR before the module re-evaluated) — at that
      // point the cb-by-reference path is `null` anyway, so the call
      // is a no-op.
      const editor = props?.editor ?? nodeView?.editor;
      const cb = nodeView?.positionCheckCallback;
      if (cb && editor) {
        cancelPositionCheck(editor, cb);
        nodeView.positionCheckCallback = null;
      }
      // Same shape, second source: the constructor also wires up
      // `editor.on("selectionUpdate", handleSelectionUpdate)` per NodeView,
      // which schedules an rAF + runs `isNodeViewSelected` for each block on
      // every cursor move (typing included). With 2k blocks that's 2k rAFs
      // queued/canceled per character. BlockView ignores `props.selected`
      // (we don't style `ProseMirror-selectednode`), so the selectNode /
      // deselectNode flow is dead weight. Detach the listener — but keep
      // the bound method on the instance so that destroy()'s subsequent
      // `editor.off("selectionUpdate", this.handleSelectionUpdate)` is a
      // safe no-op (the EventEmitter falls back to wiping ALL listeners
      // when the second arg is falsy, which would be catastrophic).
      const sel = nodeView?.handleSelectionUpdate;
      if (editor && sel) {
        editor.off("selectionUpdate", sel);
      }
      // Replace `update` to skip the per-tick `this.currentPos = this.getPos()`
      // call inside Tiptap's React NodeView base. PM's `getPos` for a
      // top-level node is O(N) — `posBeforeChild` walks the parent's children
      // array linearly to find self. With 2k NodeViews × 2k-sibling walk per
      // call, that's ~2M iterations of pointer-comparison per keystroke, and
      // it's the dominant remaining cost in `viewUpdate` after the listeners
      // above were detached. We never read `currentPos` (the only consumer
      // was the selectionUpdate listener that we just removed), so we
      // replicate the rest of Tiptap's update wrapper without that line.
      const customUpdate = nodeView.options?.update;
      if (typeof customUpdate === "function") {
        nodeView.update = function (
          node: any,
          decorations: any,
          innerDecorations: any,
        ) {
          if (node.type !== this.node.type) return false;
          const oldNode = this.node;
          const oldDecorations = this.decorations;
          const oldInnerDecorations = this.innerDecorations;
          this.node = node;
          this.decorations = decorations;
          this.innerDecorations = innerDecorations;
          return customUpdate.call(this, {
            oldNode,
            oldDecorations,
            newNode: node,
            newDecorations: decorations,
            oldInnerDecorations,
            innerDecorations,
            updateProps: () => {
              this.renderer.updateProps({
                node,
                decorations,
                innerDecorations,
                extension: this.extensionWithSyncedStorage,
              });
              if (typeof this.options.attrs === "function") {
                this.updateElementAttributes();
              }
            },
          });
        };
      }
      return nodeView;
    };
  },

  /**
   * tiptap-markdown serializer hook. Each top-level mochiBlock gets a leading
   * `<!-- block:ULID -->` comment, then its inner content is serialized using
   * the default node serializers (heading → `# ...`, paragraph → text, list →
   * `- ...`, etc.). Blocks are separated by a blank line via `closeBlock`.
   */
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          if (node.attrs.id) {
            state.write(`<!-- block:${node.attrs.id} -->\n`);
          }
          state.renderContent(node);
          state.closeBlock(node);
        },
        parse: {
          // Block boundaries on the *input* side come from the HTML loader, not
          // markdown — we don't intercept any markdown-it tokens.
        },
      },
    };
  },

  addProseMirrorPlugins() {
    return [
      // Mint a fresh ULID for any mochiBlock that's missing an id (e.g. one
      // created by Enter/split) or that has a duplicate id (e.g. from
      // copy/paste). Only runs the full scan when the top-level block count
      // actually changed — plain text edits keep the count the same and skip
      // the walk entirely. With 2k blocks this turns a per-keystroke 2k-node
      // sweep into a no-op.
      new Plugin({
        key: idMintKey,
        appendTransaction: (trs, oldState, newState) => {
          if (!trs.some((tr) => tr.docChanged)) return null;
          if (oldState.doc.childCount === newState.doc.childCount) return null;

          const seen = new Set<string>();
          let tr = newState.tr;
          let modified = false;
          // Top-level only — `forEach` is cheaper than `descendants` here
          // since mochiBlocks live directly under doc.
          newState.doc.forEach((node, pos) => {
            if (node.type.name !== "mochiBlock") return;
            const id: string | null = node.attrs.id;
            if (!id || seen.has(id)) {
              const fresh = ulid();
              tr = tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                id: fresh,
              });
              seen.add(fresh);
              modified = true;
            } else {
              seen.add(id);
            }
          });
          return modified ? tr : null;
        },
      }),
    ];
  },
});

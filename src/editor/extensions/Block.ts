import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Decoration } from "@tiptap/pm/view";
import { ulid } from "ulid";
import { BlockView } from "../BlockView";

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
    return ReactNodeViewRenderer(BlockView, {
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
        updateProps();
        return true;
      },
    });
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

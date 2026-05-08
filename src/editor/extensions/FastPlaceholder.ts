import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

interface FastPlaceholderOptions {
  placeholder:
    | string
    | ((props: { node: PMNode; pos: number; hasAnchor: boolean }) => string);
  emptyNodeClass: string;
  emptyEditorClass: string;
  dataAttribute: string;
  showOnlyWhenEditable: boolean;
}

function prepareDataAttribute(attr: string): string {
  return `data-${attr.replace(/^data-/, "")}`;
}

function isEmptyTextblock(node: PMNode): boolean {
  return node.type.isTextblock && node.content.size === 0;
}

function isDocEffectivelyEmpty(doc: PMNode): boolean {
  if (doc.childCount !== 1) return false;
  const only = doc.firstChild;
  if (!only) return true;
  if (isEmptyTextblock(only)) return true;
  if (only.type.name !== "mochiBlock" || only.childCount !== 1) return false;
  const inner = only.firstChild;
  return !!inner && isEmptyTextblock(inner);
}

/**
 * Selection-only placeholder for large canvas documents.
 *
 * Tiptap's stock Placeholder extension scans the whole document whenever
 * decorations are requested. The canvas has `mochiBlock` wrappers, which
 * requires child traversal and turns every keypress into a 2k+ node walk.
 * This extension decorates only the current empty textblock.
 */
export const FastPlaceholder = Extension.create<FastPlaceholderOptions>({
  name: "fastPlaceholder",

  addOptions() {
    return {
      placeholder: "Write something...",
      emptyNodeClass: "is-empty",
      emptyEditorClass: "is-editor-empty",
      dataAttribute: "placeholder",
      showOnlyWhenEditable: true,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    const editor = this.editor;
    const dataAttribute = prepareDataAttribute(options.dataAttribute);

    return [
      new Plugin({
        key: new PluginKey("fastPlaceholder"),
        props: {
          decorations(state) {
            if (options.showOnlyWhenEditable && !editor.isEditable) return null;
            if (!state.selection.empty) return null;

            const { $from } = state.selection;
            for (let depth = $from.depth; depth > 0; depth--) {
              const node = $from.node(depth);
              if (!isEmptyTextblock(node)) continue;

              const pos = $from.before(depth);
              const text =
                typeof options.placeholder === "function"
                  ? options.placeholder({ node, pos, hasAnchor: true })
                  : options.placeholder;
              const classes = [options.emptyNodeClass];
              if (isDocEffectivelyEmpty(state.doc)) {
                classes.push(options.emptyEditorClass);
              }

              return DecorationSet.create(state.doc, [
                Decoration.node(pos, pos + node.nodeSize, {
                  class: classes.join(" "),
                  [dataAttribute]: text,
                }),
              ]);
            }
            return null;
          },
        },
      }),
    ];
  },
});

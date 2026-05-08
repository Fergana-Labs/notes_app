import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const HASHTAG_RE = /(^|\s)(#[A-Za-z][A-Za-z0-9_\-/]*)/g;

/**
 * Inline highlight for `#tag` patterns. Gives users visual confirmation that
 * a hashtag is recognized — independent of whether they used the picker.
 *
 * Skips text inside heading nodes (where the `# ` prefix is heading syntax)
 * and inside code marks / code blocks.
 */
export const HashtagHighlight = Extension.create({
  name: "hashtagHighlight",

  addProseMirrorPlugins() {
    const key = new PluginKey("hashtagHighlight");
    return [
      new Plugin({
        key,
        state: {
          init: (_, { doc }) => buildDecos(doc),
          apply: (tr, old) => (tr.docChanged ? buildDecos(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});

function buildDecos(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return;
    if (parent && (parent.type.name === "codeBlock" || parent.type.name === "code")) {
      return;
    }
    if (node.marks.some((m) => m.type.name === "code")) return;

    const text = node.text;
    HASHTAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HASHTAG_RE.exec(text)) !== null) {
      const hashOffset = m.index + m[1].length; // skip leading whitespace
      const tagLen = m[2].length;
      decos.push(
        Decoration.inline(pos + hashOffset, pos + hashOffset + tagLen, {
          class: "mochi-tag",
        }),
      );
    }
  });
  return DecorationSet.create(doc, decos);
}

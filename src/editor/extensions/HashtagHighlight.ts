import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const HASHTAG_RE = /(^|\s)(#[A-Za-z][A-Za-z0-9_\-/]*)/g;

/**
 * Inline highlight for `#tag` patterns. Gives visual confirmation that a
 * hashtag is recognized — independent of whether the picker was used.
 *
 * Large-doc note: keeping a document-wide DecorationSet means every character
 * insert has to map every hashtag decoration after the cursor. On 2k+ block
 * canvases that is enough to make typing lag. Instead we decorate only the
 * active textblock; inactive blocks stay plain text until the cursor enters
 * them.
 */
export const HashtagHighlight = Extension.create({
  name: "hashtagHighlight",

  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>("hashtagHighlight");
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => buildAtSelection(state.doc, state.selection),
          apply: (_tr, _old, _oldState, newState) =>
            buildAtSelection(newState.doc, newState.selection),
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

function buildAtSelection(doc: PMNode, selection: any): DecorationSet {
  if (!selection.empty) return DecorationSet.empty;

  const $from = selection.$from;
  let from: number | null = null;
  let to: number | null = null;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!node.type.isTextblock) continue;
    if (node.type.name === "codeBlock") return DecorationSet.empty;
    from = $from.start(depth);
    to = $from.end(depth);
    break;
  }

  if (from == null || to == null || from >= to) return DecorationSet.empty;

  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (!node.isText || !node.text) return;
    if (
      parent &&
      (parent.type.name === "codeBlock" || parent.type.name === "code")
    ) {
      return;
    }
    if (node.marks.some((m) => m.type.name === "code")) return;
    pushTagDecorations(decos, pos, node.text);
  });
  return DecorationSet.create(doc, decos);
}

function pushTagDecorations(out: Decoration[], pos: number, text: string) {
  HASHTAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HASHTAG_RE.exec(text)) !== null) {
    const hashOffset = m.index + m[1].length;
    const tagLen = m[2].length;
    out.push(
      Decoration.inline(
        pos + hashOffset,
        pos + hashOffset + tagLen,
        { class: "mochi-tag" },
      ),
    );
  }
}

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const HASHTAG_RE = /(^|\s)(#[A-Za-z][A-Za-z0-9_\-/]*)/g;

/**
 * Inline highlight for `#tag` patterns. Gives visual confirmation that a
 * hashtag is recognized — independent of whether the picker was used.
 *
 * Large-doc note: the naive implementation (rebuild the entire doc-wide
 * DecorationSet on every transaction) made typing in 2k+ block canvases
 * lag because every keystroke walked all 2k blocks and their text. We
 * keep the doc-wide highlighting (so tags are visible everywhere, not
 * just in the active block) but cache the *relative* offsets per block
 * keyed on the PM Node reference. PM nodes are immutable, so an unedited
 * block's offsets come from the cache in O(1); a single-block edit only
 * re-walks that block. The overall doc walk is O(N) cache lookups —
 * cheap enough that 2k blocks rebuild in well under a millisecond.
 */
interface RelOffset {
  from: number;
  to: number;
}

const blockOffsets = new WeakMap<PMNode, RelOffset[]>();

function offsetsForBlock(block: PMNode): RelOffset[] {
  const cached = blockOffsets.get(block);
  if (cached) return cached;
  const out: RelOffset[] = [];
  // `pos` is relative to the start of `block.content`; the doc-wide caller
  // adds the block's content start position to make decorations absolute.
  block.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return;
    if (
      parent &&
      (parent.type.name === "codeBlock" || parent.type.name === "code")
    ) {
      return;
    }
    if (node.marks.some((m) => m.type.name === "code")) return;
    HASHTAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = HASHTAG_RE.exec(node.text)) !== null) {
      const hashOffset = m.index + m[1].length;
      const tagLen = m[2].length;
      out.push({ from: pos + hashOffset, to: pos + hashOffset + tagLen });
    }
  });
  blockOffsets.set(block, out);
  return out;
}

function buildDocWide(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== "mochiBlock") return;
    // +1 to skip the mochiBlock's opening token so positions land inside
    // its content range.
    const contentStart = offset + 1;
    const offs = offsetsForBlock(block);
    for (const o of offs) {
      decos.push(
        Decoration.inline(
          contentStart + o.from,
          contentStart + o.to,
          { class: "mochi-tag" },
        ),
      );
    }
  });
  return decos.length > 0 ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

export const HashtagHighlight = Extension.create({
  name: "hashtagHighlight",

  addProseMirrorPlugins() {
    const key = new PluginKey<DecorationSet>("hashtagHighlight");
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => buildDocWide(state.doc),
          apply: (tr, prev) => (tr.docChanged ? buildDocWide(tr.doc) : prev),
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

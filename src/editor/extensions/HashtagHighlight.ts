import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

const HASHTAG_RE = /(^|\s)(#[A-Za-z][A-Za-z0-9_\-/]*)/g;
const TAG_CLASS = "mochi-tag";

/**
 * Inline highlight for `#tag` patterns. Gives visual confirmation that a
 * hashtag is recognized — independent of whether the picker was used.
 *
 * Large-doc note: a naive doc-wide rebuild on every transaction made typing
 * in 2k+ block canvases lag (≈3-5ms/keystroke just to walk the doc and
 * allocate Decoration objects, even with a per-block offset cache). The
 * apply step now stays incremental:
 *   1. Selection-only transactions reuse the existing DecorationSet.
 *   2. Doc edits remap the existing set via `prev.map(tr.mapping, tr.doc)`
 *      — cheap, internal to PM, just shifts positions.
 *   3. We then find the top-level mochiBlocks whose node reference changed
 *      (PM nodes are immutable), strip their old decorations from the
 *      remapped set, and add fresh ones from the per-block offset cache.
 * For a single-block edit the cost is O(1) blocks rebuilt, regardless of N.
 *
 * Structural changes (block count differs) fall back to a full rebuild
 * since matching positions across an inserted/deleted block is fiddly.
 * Those happen on Enter / Backspace-merge — much rarer than typing.
 */
interface RelOffset {
  from: number;
  to: number;
}

const blockOffsetCache = new WeakMap<PMNode, RelOffset[]>();

function offsetsForBlock(block: PMNode): RelOffset[] {
  const cached = blockOffsetCache.get(block);
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
  blockOffsetCache.set(block, out);
  return out;
}

function decosForBlock(block: PMNode, contentStart: number): Decoration[] {
  const offs = offsetsForBlock(block);
  if (offs.length === 0) return [];
  const out: Decoration[] = new Array(offs.length);
  for (let i = 0; i < offs.length; i++) {
    const o = offs[i];
    out[i] = Decoration.inline(
      contentStart + o.from,
      contentStart + o.to,
      { class: TAG_CLASS },
    );
  }
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
    for (let i = 0; i < offs.length; i++) {
      const o = offs[i];
      decos.push(
        Decoration.inline(
          contentStart + o.from,
          contentStart + o.to,
          { class: TAG_CLASS },
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
          apply: (tr, prev) => {
            if (!tr.docChanged) return prev;
            const oldDoc = tr.before;
            const newDoc = tr.doc;

            // Structural change: doc.childCount differs (Enter splits a block,
            // Backspace merges two, paste inserts a block, etc.). Rebuild
            // from scratch — block-index alignment is no longer reliable.
            if (oldDoc.childCount !== newDoc.childCount) {
              return buildDocWide(newDoc);
            }

            // Same childCount: walk in lockstep, find the (usually one)
            // mochiBlock whose node reference changed. PM nodes are
            // immutable, so a single-character edit produces exactly one
            // changed top-level child.
            const changed: { contentStart: number; block: PMNode }[] = [];
            let pos = 0;
            for (let i = 0; i < newDoc.childCount; i++) {
              const newChild = newDoc.child(i);
              const oldChild = oldDoc.child(i);
              if (newChild !== oldChild && newChild.type.name === "mochiBlock") {
                changed.push({ contentStart: pos + 1, block: newChild });
              }
              pos += newChild.nodeSize;
            }

            // Remap existing decorations to new positions (cheap — PM keeps
            // the decoset as a tree and shifts positions internally).
            let next = prev.map(tr.mapping, newDoc);
            if (changed.length === 0) return next;

            // For each changed block: drop its old (already-mapped)
            // decorations and add freshly-built ones from the cache. PM
            // nodes are immutable, so `offsetsForBlock` cache-misses only
            // for blocks whose ref changed — exactly what we want.
            const toRemove: Decoration[] = [];
            const toAdd: Decoration[] = [];
            for (const c of changed) {
              const blockEnd = c.contentStart + c.block.content.size;
              const within = next.find(c.contentStart - 1, blockEnd + 1);
              for (let i = 0; i < within.length; i++) toRemove.push(within[i]);
              const fresh = decosForBlock(c.block, c.contentStart);
              for (let i = 0; i < fresh.length; i++) toAdd.push(fresh[i]);
            }
            if (toRemove.length > 0) next = next.remove(toRemove);
            if (toAdd.length > 0) next = next.add(newDoc, toAdd);
            return next;
          },
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

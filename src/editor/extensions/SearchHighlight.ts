import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

interface SearchState {
  /** Current query — empty string when search is inactive. */
  query: string;
  /** Block id currently focused by the user (jump target). Decorations
   *  inside that block are styled as "active" (stronger color). */
  activeId: string | null;
  /** Cached decoration set — never recomputed for selection-only updates. */
  decos: DecorationSet;
}

const searchKey = new PluginKey<SearchState>("mochiSearchHighlight");

const HIGHLIGHT_CLASS = "mochi-search-hit";
const ACTIVE_HIGHLIGHT_CLASS = "mochi-search-hit-active";

/** Tokenize the query: split on whitespace, drop empties, lowercase. The
 *  FTS query language allows operators / quoted phrases — we ignore those
 *  for the in-editor highlight (the snippet from the FTS hit already shows
 *  the structural match). For visual highlighting we just want to mark
 *  every literal occurrence of the user's words. */
function tokensFor(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/["'`]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Per-block offset cache keyed by PM node ref. Survives across edits
 *  because PM nodes are immutable: any block the user hasn't touched
 *  keeps the same ref and hits the cache. */
const blockOffsetCache = new WeakMap<PMNode, { re: RegExp; offsets: { from: number; to: number }[] }>();

function offsetsForBlock(block: PMNode, re: RegExp): { from: number; to: number }[] {
  const cached = blockOffsetCache.get(block);
  if (cached && cached.re.source === re.source && cached.re.flags === re.flags) {
    return cached.offsets;
  }
  const out: { from: number; to: number }[] = [];
  block.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return;
    if (parent && parent.type.name === "codeBlock") return;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(node.text)) !== null) {
      const from = pos + m.index;
      const to = from + m[0].length;
      out.push({ from, to });
    }
  });
  blockOffsetCache.set(block, { re, offsets: out });
  return out;
}

function decosForBlock(
  block: PMNode,
  contentStart: number,
  re: RegExp,
  cls: string,
): Decoration[] {
  const offs = offsetsForBlock(block, re);
  if (offs.length === 0) return [];
  const out: Decoration[] = new Array(offs.length);
  for (let i = 0; i < offs.length; i++) {
    const o = offs[i];
    out[i] = Decoration.inline(
      contentStart + o.from,
      contentStart + o.to,
      { class: cls },
    );
  }
  return out;
}

function buildDocWide(doc: PMNode, state: SearchState, re: RegExp | null): DecorationSet {
  if (!re) return DecorationSet.empty;
  const decos: Decoration[] = [];
  doc.forEach((block, offset) => {
    if (block.type.name !== "mochiBlock") return;
    const isActive =
      state.activeId != null && block.attrs.id === state.activeId;
    const cls = isActive
      ? `${HIGHLIGHT_CLASS} ${ACTIVE_HIGHLIGHT_CLASS}`
      : HIGHLIGHT_CLASS;
    const contentStart = offset + 1;
    const fresh = decosForBlock(block, contentStart, re, cls);
    for (let i = 0; i < fresh.length; i++) decos.push(fresh[i]);
  });
  return decos.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decos);
}

function regexForQuery(query: string): RegExp | null {
  const q = query.trim();
  if (!q) return null;
  const tokens = tokensFor(q);
  if (tokens.length === 0) return null;
  return new RegExp(`(${tokens.map(escapeRegex).join("|")})`, "gi");
}

/**
 * Inline-decoration highlighter for the current top-bar search query.
 *
 * Performance: decorations are cached in plugin state — a selection-only
 * transaction (cursor move) returns the existing set unchanged. Doc
 * edits remap the existing set via the cheap PM `prev.map(...)` and only
 * rebuild decorations for the (usually one) block whose node reference
 * changed. Same shape as HashtagHighlight — keeps typing in a 2k-block
 * canvas at a few ms per keystroke even with a search active.
 */
export const SearchHighlight = Extension.create({
  name: "mochiSearchHighlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: () => ({
            query: "",
            activeId: null,
            decos: DecorationSet.empty,
          }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(searchKey) as
              | { query: string; activeId: string | null }
              | undefined;

            // External query / activeId update → full rebuild.
            if (meta) {
              const re = regexForQuery(meta.query);
              return {
                query: meta.query,
                activeId: meta.activeId,
                decos: buildDocWide(tr.doc, { ...meta, decos: DecorationSet.empty }, re),
              };
            }

            if (!tr.docChanged) return prev;
            const re = regexForQuery(prev.query);
            if (!re) return { ...prev, decos: DecorationSet.empty };

            const oldDoc = tr.before;
            const newDoc = tr.doc;

            // Structural change: cheaper to rebuild than reconcile across
            // block-index shifts.
            if (oldDoc.childCount !== newDoc.childCount) {
              return { ...prev, decos: buildDocWide(newDoc, prev, re) };
            }

            // Lockstep walk — same idea as HashtagHighlight.
            const changed: { contentStart: number; block: PMNode; cls: string }[] = [];
            let pos = 0;
            for (let i = 0; i < newDoc.childCount; i++) {
              const newChild = newDoc.child(i);
              const oldChild = oldDoc.child(i);
              if (newChild !== oldChild && newChild.type.name === "mochiBlock") {
                const isActive =
                  prev.activeId != null && newChild.attrs.id === prev.activeId;
                const cls = isActive
                  ? `${HIGHLIGHT_CLASS} ${ACTIVE_HIGHLIGHT_CLASS}`
                  : HIGHLIGHT_CLASS;
                changed.push({ contentStart: pos + 1, block: newChild, cls });
              }
              pos += newChild.nodeSize;
            }

            // Bulk change (drag-reorder etc.) — give up on incremental.
            if (changed.length > 16 || changed.length > newDoc.childCount / 2) {
              return { ...prev, decos: buildDocWide(newDoc, prev, re) };
            }

            let next = prev.decos.map(tr.mapping, newDoc);
            if (changed.length === 0) return { ...prev, decos: next };

            const toRemove: Decoration[] = [];
            const toAdd: Decoration[] = [];
            for (const c of changed) {
              const blockEnd = c.contentStart + c.block.content.size;
              const within = next.find(c.contentStart - 1, blockEnd + 1);
              for (let i = 0; i < within.length; i++) toRemove.push(within[i]);
              const fresh = decosForBlock(c.block, c.contentStart, re, c.cls);
              for (let i = 0; i < fresh.length; i++) toAdd.push(fresh[i]);
            }
            if (toRemove.length > 0) next = next.remove(toRemove);
            if (toAdd.length > 0) next = next.add(newDoc, toAdd);
            return { ...prev, decos: next };
          },
        },
        props: {
          decorations(state) {
            const s = searchKey.getState(state);
            return s ? s.decos : null;
          },
        },
      }),
    ];
  },
});

/** Imperative API used by App.tsx to push the current search query +
 *  active block id into the editor's plugin state. */
export function setSearchState(
  editor: any,
  query: string,
  activeId: string | null,
): void {
  const view = editor?.view;
  if (!view) return;
  view.dispatch(
    view.state.tr.setMeta(searchKey, { query, activeId }),
  );
}

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * In-note find (Cmd-F). A per-editor plugin that decorates every match of
 * a query and tracks a "current" match so the find bar can step through
 * them. Driven entirely via `setMeta(findKey, …)` so the find bar can
 * control any editor it's bound to without that editor re-rendering.
 */
export interface FindState {
  query: string;
  caseSensitive: boolean;
  /** Index of the active match, or -1 when none. */
  current: number;
  /** [from, to] document positions of every match, in document order. */
  matches: { from: number; to: number }[];
  decos: DecorationSet;
}

export const findKey = new PluginKey<FindState>("findInNote");

function computeMatches(
  doc: PMNode,
  query: string,
  caseSensitive: boolean,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (!query) return out;
  const q = caseSensitive ? query : query.toLowerCase();
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = caseSensitive ? node.text : node.text.toLowerCase();
    let from = 0;
    let idx = hay.indexOf(q, from);
    while (idx >= 0) {
      out.push({ from: pos + idx, to: pos + idx + q.length });
      from = idx + q.length;
      idx = hay.indexOf(q, from);
    }
  });
  return out;
}

function buildDecos(
  doc: PMNode,
  matches: { from: number; to: number }[],
  current: number,
): DecorationSet {
  if (matches.length === 0) return DecorationSet.empty;
  const decos = matches.map((m, i) =>
    Decoration.inline(m.from, m.to, {
      class:
        i === current ? "mochi-find-match-active" : "mochi-find-match",
    }),
  );
  return DecorationSet.create(doc, decos);
}

export const FindInNote = Extension.create({
  name: "findInNote",
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({
            query: "",
            caseSensitive: false,
            current: -1,
            matches: [],
            decos: DecorationSet.empty,
          }),
          apply(tr, prev) {
            const meta = tr.getMeta(findKey) as
              | Partial<FindState>
              | undefined;
            if (meta) {
              const query = meta.query ?? prev.query;
              const caseSensitive = meta.caseSensitive ?? prev.caseSensitive;
              const matches = computeMatches(tr.doc, query, caseSensitive);
              let current = meta.current ?? prev.current;
              if (current >= matches.length) current = matches.length - 1;
              if (current < 0 && matches.length > 0) current = 0;
              if (matches.length === 0) current = -1;
              return {
                query,
                caseSensitive,
                current,
                matches,
                decos: buildDecos(tr.doc, matches, current),
              };
            }
            if (tr.docChanged && prev.query) {
              const matches = computeMatches(
                tr.doc,
                prev.query,
                prev.caseSensitive,
              );
              const current =
                matches.length === 0
                  ? -1
                  : Math.min(Math.max(prev.current, 0), matches.length - 1);
              return {
                ...prev,
                current,
                matches,
                decos: buildDecos(tr.doc, matches, current),
              };
            }
            return prev;
          },
        },
        props: {
          decorations(state) {
            return findKey.getState(state)?.decos;
          },
        },
      }),
    ];
  },
});

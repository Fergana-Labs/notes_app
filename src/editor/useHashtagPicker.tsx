import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { useWorkspace } from "../stores/workspace";

const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_\-/]*$/;

interface PickerSuggestion {
  kind: "existing" | "create";
  name: string;
}

/**
 * Inline `#tag` autocomplete for the card / note editors. When the cursor
 * sits inside a partial `#xxx` token, a dropdown of matching workspace
 * tags (plus a "create new" option) appears anchored at the caret. Picking
 * one inserts `#name ` — the editor's existing terminator-lift then turns
 * it into a chip on the block.
 *
 * Mirrors the capture bar's picker but is reusable: returns a keydown
 * handler to wire into `editorProps.handleKeyDown`, a `sync` callback to
 * call from `onUpdate`/`onSelectionUpdate`, and the dropdown element.
 */
export function useHashtagPicker(editor: Editor | null) {
  const tags = useWorkspace((s) => s.tags);
  const tagsRef = useRef(tags);
  useEffect(() => {
    tagsRef.current = tags;
  }, [tags]);

  const [query, setQuery] = useState<string | null>(null);
  const [range, setRange] = useState<{ from: number; to: number } | null>(null);
  const [idx, setIdx] = useState(0);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null,
  );

  const suggestions: PickerSuggestion[] = useMemo(() => {
    if (query === null) return [];
    const q = query.toLowerCase();
    const names = tagsRef.current.map((t) => t.tag);
    let matches = names.filter((t) => !q || t.toLowerCase().includes(q));
    matches.sort((a, b) => {
      if (!q) return a.localeCompare(b);
      const ap = a.toLowerCase().startsWith(q);
      const bp = b.toLowerCase().startsWith(q);
      if (ap && !bp) return -1;
      if (!ap && bp) return 1;
      return a.localeCompare(b);
    });
    matches = matches.slice(0, 8);
    const createSlot: PickerSuggestion[] =
      q.length > 0 &&
      TAG_NAME_RE.test(q) &&
      !names.some((t) => t.toLowerCase() === q)
        ? [{ kind: "create", name: q }]
        : [];
    return [...createSlot, ...matches.map((t) => ({ kind: "existing" as const, name: t }))];
  }, [query, tags]);

  useEffect(() => {
    setIdx(0);
  }, [query]);

  // Refs read inside the editor's synchronous keydown handler.
  const openRef = useRef(false);
  const suggestionsRef = useRef(suggestions);
  const idxRef = useRef(idx);
  const rangeRef = useRef(range);
  useEffect(() => {
    openRef.current = query !== null;
  }, [query]);
  useEffect(() => {
    suggestionsRef.current = suggestions;
  }, [suggestions]);
  useEffect(() => {
    idxRef.current = idx;
  }, [idx]);
  useEffect(() => {
    rangeRef.current = range;
  }, [range]);

  const detect = (
    ed: Editor,
  ): { query: string; range: { from: number; to: number } } | null => {
    const { doc, selection } = ed.state;
    if (!selection.empty) return null;
    const cursor = selection.head;
    let result: { query: string; range: { from: number; to: number } } | null =
      null;
    doc.descendants((node, pos, parent) => {
      if (result) return false;
      if (!node.isText || !node.text) return;
      if (
        parent &&
        (parent.type.name === "codeBlock" || parent.type.name === "code")
      ) {
        return;
      }
      const re = /(^|[\s])#([A-Za-z][A-Za-z0-9_\-/]*)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(node.text)) !== null) {
        const hashAt = pos + m.index + m[1].length;
        const tagEnd = hashAt + 1 + (m[2]?.length ?? 0);
        if (cursor >= hashAt + 1 && cursor <= tagEnd) {
          result = {
            query: (m[2] ?? "").toLowerCase(),
            range: { from: hashAt, to: tagEnd },
          };
          return false;
        }
      }
    });
    return result;
  };

  const sync = useCallback((ed: Editor) => {
    const next = detect(ed);
    if (next) {
      setQuery(next.query);
      setRange(next.range);
      try {
        const c = ed.view.coordsAtPos(next.range.from);
        setCoords({ left: c.left, top: c.bottom });
      } catch {
        setCoords(null);
      }
    } else {
      setQuery(null);
      setRange(null);
      setCoords(null);
    }
  }, []);

  const close = useCallback(() => {
    setQuery(null);
    setRange(null);
    setCoords(null);
  }, []);

  const commit = useCallback(
    (name: string) => {
      if (!editor) return;
      const r = rangeRef.current;
      if (!r) return;
      const t = name.trim().toLowerCase().replace(/^#/, "");
      if (!TAG_NAME_RE.test(t)) return;
      editor.chain().focus().insertContentAt(r, `#${t} `).run();
      close();
    },
    [editor, close],
  );

  // Wire into editorProps.handleKeyDown. Returns true when it consumed
  // the key (picker open + nav/commit/close).
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      if (!openRef.current) return false;
      const sugs = suggestionsRef.current;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setIdx((i) => Math.min(i + 1, Math.max(0, sugs.length - 1)));
        return true;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
        return true;
      }
      if (event.key === "Enter") {
        const pick = sugs[idxRef.current];
        if (pick) {
          event.preventDefault();
          commit(pick.name);
          return true;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return true;
      }
      return false;
    },
    [commit, close],
  );

  const dropdown =
    query !== null && suggestions.length > 0 && coords
      ? createPortal(
          <div
            style={{
              position: "fixed",
              left: coords.left,
              top: coords.top + 4,
              zIndex: 60,
            }}
            className="w-48 max-h-56 overflow-y-auto rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl py-1 text-sm"
            onMouseDown={(e) => e.preventDefault()}
          >
            {suggestions.map((s, i) => (
              <button
                key={`${s.kind}:${s.name}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => commit(s.name)}
                className={`w-full flex items-center gap-2 px-2 py-1 text-left ${
                  i === idx
                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                    : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                }`}
              >
                <span className="font-mono">#{s.name}</span>
                {s.kind === "create" && (
                  <span className="ml-auto text-[10px] text-neutral-400">new</span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )
      : null;

  return { sync, handleKeyDown, dropdown, close };
}

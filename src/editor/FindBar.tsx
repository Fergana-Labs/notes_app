import { useEffect, useRef, useState } from "react";
import { ChevronUp, ChevronDown, X } from "lucide-react";
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import {
  getActiveEditor,
  subscribeActiveEditor,
} from "./activeEditor";
import { findKey, type FindState } from "./extensions/FindInNote";

/**
 * Cmd-F "find in note" bar. Opens on the `mochi:find-in-note` event,
 * binds to whichever editor is currently active, highlights matches, and
 * steps through them with Enter / Shift+Enter. Esc (or the ×) closes and
 * clears the highlight. Distinct from Cmd-K, which focuses the global
 * search bar.
 */
export function FindBar() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [count, setCount] = useState({ current: 0, total: 0 });
  const editorRef = useRef<Editor | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Push the query into the bound editor's find plugin and read back the
  // match count.
  const apply = (q: string, current?: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.view.dispatch(
      ed.state.tr.setMeta(findKey, { query: q, ...(current != null ? { current } : {}) }),
    );
    const st = findKey.getState(ed.state) as FindState | undefined;
    if (st) {
      setCount({ current: st.matches.length ? st.current + 1 : 0, total: st.matches.length });
      scrollToCurrent(ed, st);
    }
  };

  const scrollToCurrent = (ed: Editor, st: FindState) => {
    const m = st.matches[st.current];
    if (!m) return;
    // Move the selection to the match so it scrolls into view, then return
    // focus to the find input so the user can keep stepping.
    const tr = ed.state.tr.setSelection(
      TextSelection.create(ed.state.doc, m.from, m.to),
    );
    tr.scrollIntoView();
    ed.view.dispatch(tr);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const step = (dir: 1 | -1) => {
    const ed = editorRef.current;
    if (!ed) return;
    const st = findKey.getState(ed.state) as FindState | undefined;
    if (!st || st.matches.length === 0) return;
    const next =
      (st.current + dir + st.matches.length) % st.matches.length;
    ed.view.dispatch(ed.state.tr.setMeta(findKey, { current: next }));
    const after = findKey.getState(ed.state) as FindState | undefined;
    if (after) {
      setCount({ current: after.current + 1, total: after.matches.length });
      scrollToCurrent(ed, after);
    }
  };

  const close = () => {
    const ed = editorRef.current;
    if (ed) ed.view.dispatch(ed.state.tr.setMeta(findKey, { query: "" }));
    setOpen(false);
    setQuery("");
    setCount({ current: 0, total: 0 });
  };

  useEffect(() => {
    const onFind = () => {
      const ed = getActiveEditor();
      if (!ed) return; // No note focused — nothing to find in.
      editorRef.current = ed;
      setOpen(true);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    };
    window.addEventListener("mochi:find-in-note", onFind);
    return () => window.removeEventListener("mochi:find-in-note", onFind);
  }, []);

  // Close the bar when the user moves focus into a *different* note — the
  // find was scoped to the previous one. A brief blur (e === null, e.g.
  // clicking into the find input itself) keeps the bar open.
  useEffect(() => {
    return subscribeActiveEditor((e) => {
      if (!open) return;
      if (e !== null && e !== editorRef.current) close();
    });
  }, [open]);

  if (!open) return null;

  return (
    <div className="absolute top-3 right-6 z-40 flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg px-2 py-1.5">
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          apply(e.target.value, 0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
        placeholder="Find in note"
        className="w-44 bg-transparent outline-none text-sm px-1 placeholder:text-neutral-400"
      />
      <span className="text-[11px] text-neutral-400 tabular-nums min-w-[44px] text-center">
        {query ? `${count.current}/${count.total}` : ""}
      </span>
      <button
        onClick={() => step(-1)}
        title="Previous match (Shift+Enter)"
        className="p-1 rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <ChevronUp size={14} />
      </button>
      <button
        onClick={() => step(1)}
        title="Next match (Enter)"
        className="p-1 rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <ChevronDown size={14} />
      </button>
      <button
        onClick={close}
        title="Close (Esc)"
        className="p-1 rounded text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      >
        <X size={14} />
      </button>
    </div>
  );
}

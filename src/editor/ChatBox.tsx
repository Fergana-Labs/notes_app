import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { useEffect, useRef, useState } from "react";
import { ulid } from "ulid";
import {
  Send,
  ArrowUpToLine,
  ArrowDownToLine,
  ChevronDown,
  X,
} from "lucide-react";
import { useWorkspace } from "../stores/workspace";
import { useChatSettings } from "../stores/chatSettings";
import { useUISettings } from "../stores/uiSettings";
import { Hashtag } from "./extensions/Hashtag";
import { HashtagHighlight } from "./extensions/HashtagHighlight";
import { unescapeInlineHashtags } from "../lib/markdown";

const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_\-/]*$/;

interface Props {
  /** Currently-active tag filter (from App.tsx). When set, new blocks
   *  are pre-seeded with `#tag` so they immediately appear in the
   *  filtered view. */
  tagFilter?: string | null;
  /** True when the canvas is showing the single-block fullscreen editor.
   *  ChatBox still captures to "all blocks" — this prop just tweaks the
   *  placeholder so the user understands the capture isn't scoped to
   *  the open block. */
  fullscreen?: boolean;
}

/**
 * Chat-style capture bar pinned to the bottom of the canvas.
 *  - Enter           → submit (insert as a new block at top / bottom).
 *  - Shift+Enter     → new paragraph (true paragraph split, not a `<br>`).
 *  - `#tag`          → autocomplete picker (same as the main editor).
 *
 * Saves go through `workspace.saveSnapshot` directly — no dependency on
 * a single canvas editor (the feed has many per-card editors now).
 * Listens for `mochi:focus-chatbox` from the Cmd-N keyboard shortcut so
 * the user can capture from anywhere.
 */
export function ChatBox({ tagFilter = null, fullscreen = false }: Props) {
  const tags = useWorkspace((s) => s.tags);
  const blocks = useWorkspace((s) => s.blocks);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);
  const tagsRef = useRef(tags);
  useEffect(() => {
    tagsRef.current = tags;
  }, [tags]);
  const blocksRef = useRef(blocks);
  useEffect(() => {
    blocksRef.current = blocks;
  }, [blocks]);
  const tagFilterRef = useRef(tagFilter);
  useEffect(() => {
    tagFilterRef.current = tagFilter;
  }, [tagFilter]);
  const fullscreenRef = useRef(fullscreen);
  useEffect(() => {
    fullscreenRef.current = fullscreen;
  }, [fullscreen]);

  const direction = useChatSettings((s) => s.direction);
  const setDirection = useChatSettings((s) => s.setDirection);
  const loadSettings = useChatSettings((s) => s.load);
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);
  const colorful = useUISettings((s) => s.colorful);

  const [showDirMenu, setShowDirMenu] = useState(false);
  // Chips lifted out of the typed text. When the user types `#tag ` (or
  // `#tag,`), the hashtag token is removed from the input and appended
  // here. Submit merges these into the new block's tags field; Backspace
  // at the start of an empty editor pops the last chip back into the
  // input as `#tag` so the user can edit or re-lift it.
  const [pendingTags, setPendingTags] = useState<string[]>([]);
  const pendingTagsRef = useRef(pendingTags);
  useEffect(() => {
    pendingTagsRef.current = pendingTags;
  }, [pendingTags]);

  const addPendingTag = (raw: string) => {
    const t = raw.trim().toLowerCase().replace(/^#/, "");
    if (!TAG_NAME_RE.test(t)) return;
    setPendingTags((prev) => (prev.includes(t) ? prev : [...prev, t]));
  };

  const removePendingTag = (tag: string) => {
    setPendingTags((prev) => prev.filter((t) => t !== tag));
  };

  const editor = useEditor({
    extensions: [
      // Disable HardBreak — we use paragraph splits for newlines instead.
      StarterKit.configure({
        hardBreak: false,
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: "mochi-link" },
        },
      }),
      Markdown.configure({ html: false, linkify: true, breaks: false }),
      Placeholder.configure({
        placeholder: () =>
          fullscreenRef.current
            ? "Capture a thought (goes to all blocks)…"
            : "Capture a thought…",
        showOnlyWhenEditable: true,
      }),
      Hashtag.configure({
        getTags: () => tagsRef.current.map((t) => t.tag),
      }),
      HashtagHighlight,
    ],
    content: "",
    editorProps: {
      handleKeyDown(view, event) {
        // Don't intercept while a hashtag picker is open.
        if (event.key === "Enter") {
          for (const p of view.state.plugins) {
            const s = (p as any).getState?.(view.state);
            if (s && typeof s === "object" && (s as any).active) return false;
          }
          if (event.shiftKey) {
            // Shift+Enter → split paragraph.
            event.preventDefault();
            view.dispatch(
              view.state.tr.split(view.state.selection.$from.pos).scrollIntoView(),
            );
            return true;
          }
          // Plain Enter → submit.
          event.preventDefault();
          submit();
          return true;
        }
        // Backspace at the very start of an empty editor pops the
        // most-recent chip back into the input so the user can edit
        // or re-lift it. Mirrors how chip-based inputs (email To: rows,
        // tag inputs) typically behave.
        if (event.key === "Backspace") {
          const { selection, doc } = view.state;
          const empty =
            selection.empty &&
            selection.from === 1 &&
            doc.textContent.length === 0;
          const chips = pendingTagsRef.current;
          if (empty && chips.length > 0) {
            event.preventDefault();
            const last = chips[chips.length - 1];
            setPendingTags(chips.slice(0, -1));
            view.dispatch(
              view.state.tr.insertText(`#${last}`).scrollIntoView(),
            );
            return true;
          }
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      // Scan the current doc for `#tag ` / `#tag,` / `#tag\n` patterns
      // — when a terminator follows a complete hashtag, lift the tag
      // out into the chip strip and delete the `#tag` + the terminator
      // from the editor. Multiple matches per pass are handled (paste
      // of `#a #b #c ` will lift all three on the same update).
      liftTerminatedHashtags(editor);
    },
  });

  // Pull `#name` tokens followed by space/comma/newline out of the
  // editor's doc and into `pendingTags`. Runs on every update. Stops
  // when no more terminated tags remain.
  function liftTerminatedHashtags(ed: any) {
    const liftRe = /(?:^|[\s])#([A-Za-z][A-Za-z0-9_\-/]*)([\s,])/;
    let safety = 0;
    // Each lift mutates the doc; rerun until idempotent or safety cap.
    while (safety++ < 8) {
      const md: string =
        (ed.storage as any).markdown?.getMarkdown?.() ?? "";
      const m = md.match(liftRe);
      if (!m || m.index === undefined) return;
      const tag = m[1].toLowerCase();
      if (!TAG_NAME_RE.test(tag)) return;
      // Don't lift if the cursor is currently sitting INSIDE the tag
      // token (user still typing). Lift only happens once the
      // terminator is committed — but if the user typed the
      // terminator, the cursor sits AFTER the terminator, so we can
      // safely lift.
      addPendingTag(tag);
      // Compute the byte range to remove from the editor: leading
      // boundary (if it was a non-newline whitespace) is consumed,
      // the `#tag` is consumed, and the terminator is consumed. The
      // markdown-position → PM-position mapping isn't 1:1, so use a
      // text-based replace via the markdown storage.
      const matchStr = m[0];
      const leadingChar = matchStr[0];
      const replacement = leadingChar === "#" ? "" : leadingChar;
      const newMd = md.slice(0, m.index) + replacement + md.slice(m.index + matchStr.length);
      ed.commands.setContent(newMd, { emitUpdate: false });
      // After setContent, the cursor jumps to start — restore it to
      // end so the user can keep typing.
      ed.commands.focus("end");
    }
  }

  // Focus from anywhere via Cmd-N (App-level listener dispatches this).
  useEffect(() => {
    const onFocus = () => {
      if (!editor) return;
      editor.commands.focus("end");
    };
    window.addEventListener("mochi:focus-chatbox", onFocus);
    return () => window.removeEventListener("mochi:focus-chatbox", onFocus);
  }, [editor]);

  const submit = async () => {
    if (!editor) return;
    const md: string = (editor.storage as any).markdown?.getMarkdown?.() ?? "";
    const cleaned = unescapeInlineHashtags(md).trim();
    const chips = pendingTagsRef.current;
    if (!cleaned && chips.length === 0) return;

    // Tag set for the new block: chips lifted while typing + the
    // active tag filter (so the new block lands in the narrowed view
    // when one is set). Inline hashtags still in `cleaned` are
    // extracted server-side and merged automatically.
    const explicitTags: string[] = [];
    for (const t of chips) {
      if (!explicitTags.includes(t)) explicitTags.push(t);
    }
    if (tagFilterRef.current && !explicitTags.includes(tagFilterRef.current)) {
      explicitTags.push(tagFilterRef.current);
    }

    const all = [...blocksRef.current].sort((a, b) => a.position - b.position);
    const newId = ulid();
    let position: number;
    let parentId: string | null = null;
    if (direction === "top") {
      const first = all[0];
      position = (first?.position ?? 0) - 1;
      parentId = first?.parent_id ?? null;
    } else {
      const last = all[all.length - 1];
      position = (last?.position ?? -1) + 1;
      parentId = last?.parent_id ?? null;
    }

    await saveSnapshot(
      [
        {
          id: newId,
          content: cleaned,
          position,
          parent_id: parentId,
          heading: null,
          heading_level: null,
          tags: explicitTags.length > 0 ? explicitTags : undefined,
        },
      ],
      [],
    );

    setPendingTags([]);
    editor.commands.clearContent();
    editor.commands.focus();
  };

  return (
    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-white/95 dark:bg-neutral-950/95 backdrop-blur">
      <div className="max-w-3xl mx-auto px-6 py-3">
        {pendingTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mb-1.5 px-1">
            {pendingTags.map((t) => (
              <span
                key={t}
                className="group/chip inline-flex items-center gap-0.5 pl-2 pr-1 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 text-xs font-medium"
              >
                <span>#{t}</span>
                <button
                  type="button"
                  onClick={() => removePendingTag(t)}
                  title={`Remove #${t}`}
                  className="text-blue-400 hover:text-blue-700 dark:hover:text-blue-200 leading-none"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5 rounded-xl border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-sm focus-within:border-neutral-400 dark:focus-within:border-neutral-600 transition-colors">
          <div className="flex-1 min-w-0 px-3 py-2 max-h-48 overflow-y-auto">
            <EditorContent editor={editor} />
          </div>

          <div className="flex items-center gap-0.5 px-2 py-2 shrink-0">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowDirMenu((v) => !v)}
                title={
                  direction === "top"
                    ? "New blocks added at top of canvas"
                    : "New blocks added at bottom of canvas"
                }
                className="flex items-center gap-0.5 px-1.5 py-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                {direction === "top" ? (
                  <ArrowUpToLine size={14} />
                ) : (
                  <ArrowDownToLine size={14} />
                )}
                <ChevronDown size={10} />
              </button>
              {showDirMenu && (
                <div
                  className="absolute bottom-full right-0 mb-1 w-44 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-xl py-1 z-10 text-xs"
                  onMouseLeave={() => setShowDirMenu(false)}
                >
                  <button
                    onClick={() => {
                      setDirection("top");
                      setShowDirMenu(false);
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 ${
                      direction === "top"
                        ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                        : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <ArrowUpToLine size={12} /> Add to top
                  </button>
                  <button
                    onClick={() => {
                      setDirection("bottom");
                      setShowDirMenu(false);
                    }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 ${
                      direction === "bottom"
                        ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                        : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <ArrowDownToLine size={12} /> Add to bottom
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={submit}
              title="Add as new block (Enter)"
              className={`flex items-center justify-center w-7 h-7 rounded-full text-white transition-colors ${
                colorful
                  ? "bg-[#87a970] hover:bg-[#7a9c64] active:bg-[#6d8f58]"
                  : "bg-blue-600 hover:bg-blue-700 active:bg-blue-800"
              }`}
            >
              <Send size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

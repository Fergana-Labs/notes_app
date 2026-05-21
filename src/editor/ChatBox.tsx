import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { useEffect, useRef, useState } from "react";
import { ulid } from "ulid";
import { Send, ArrowUpToLine, ArrowDownToLine, ChevronDown } from "lucide-react";
import { useWorkspace } from "../stores/workspace";
import { useChatSettings } from "../stores/chatSettings";
import { Hashtag } from "./extensions/Hashtag";
import { HashtagHighlight } from "./extensions/HashtagHighlight";
import { unescapeInlineHashtags } from "../lib/markdown";

interface Props {
  /** Currently-active tag filter (from App.tsx). When set, new blocks
   *  are pre-seeded with `#tag` so they immediately appear in the
   *  filtered view. */
  tagFilter?: string | null;
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
export function ChatBox({ tagFilter = null }: Props) {
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

  const direction = useChatSettings((s) => s.direction);
  const setDirection = useChatSettings((s) => s.setDirection);
  const loadSettings = useChatSettings((s) => s.load);
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const [showDirMenu, setShowDirMenu] = useState(false);

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
        placeholder: "Capture a thought…",
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
        return false;
      },
    },
  });

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
    if (!cleaned) return;

    // Seed with the active tag filter so the new block lands in the
    // currently-narrowed view.
    const tagPrefix = tagFilterRef.current
      ? `#${tagFilterRef.current} `
      : "";
    const finalContent = tagPrefix
      ? `${tagPrefix}${cleaned}`
      : cleaned;

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
          content: finalContent,
          position,
          parent_id: parentId,
          heading: null,
          heading_level: null,
        },
      ],
      [],
    );

    editor.commands.clearContent();
    editor.commands.focus();
  };

  return (
    <div className="border-t border-neutral-200 dark:border-neutral-800 bg-white/95 dark:bg-neutral-950/95 backdrop-blur">
      <div className="max-w-3xl mx-auto px-6 py-3">
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
              className="flex items-center justify-center w-7 h-7 rounded-full bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 transition-colors"
            >
              <Send size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

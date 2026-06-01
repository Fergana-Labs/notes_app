import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import UnderlineExtension from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import type { Editor } from "@tiptap/core";
import { CornerDownRight } from "lucide-react";
import { getMarkdownPreservingEmptyParas } from "../lib/markdown";
import { debounce } from "../lib/debounce";
import {
  todayStr,
  loadDailyDraft,
  saveDailyDraft,
  clearDailyDraft,
  flushDailyDraft,
  maybeRolloverDaily,
} from "../lib/daily";
import { Hashtag } from "./extensions/Hashtag";
import { SlashMenu } from "./extensions/SlashMenu";
import { ClipboardSerialize } from "./extensions/ClipboardSerialize";
import { FindInNote } from "./extensions/FindInNote";
import { BlockBubbleMenu } from "./BubbleMenu";
import { useHashtagPicker } from "./useHashtagPicker";
import {
  setActiveEditor,
  clearActiveEditorIf,
  rememberFocus,
  rememberSelection,
} from "./activeEditor";

/**
 * Daily note — a full-screen markdown scratchpad for today, rendered in
 * the main panel. Autosaves to the settings-backed draft; "Add to notes"
 * (and the automatic day-rollover) splits it on horizontal rules into
 * blocks on the canvas, turning inline `#hashtags` into tags. The `#`
 * autocomplete dropdown matches the regular note editor.
 */
export function DailyNotePane({ onClose }: { onClose: () => void }) {
  const [initial, setInitial] = useState<string | null>(null);
  const [flushMsg, setFlushMsg] = useState<string | null>(null);

  // On open: roll over any previous day's draft into blocks, then load
  // today's working copy.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await maybeRolloverDaily();
      const draft = await loadDailyDraft();
      if (!cancelled) setInitial(draft);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (initial === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-neutral-400">
        Loading today’s note…
      </div>
    );
  }

  return (
    <DailyEditor
      key={todayStr()}
      initial={initial}
      onClose={onClose}
      flushMsg={flushMsg}
      setFlushMsg={setFlushMsg}
    />
  );
}

function DailyEditor({
  initial,
  onClose,
  flushMsg,
  setFlushMsg,
}: {
  initial: string;
  onClose: () => void;
  flushMsg: string | null;
  setFlushMsg: (m: string | null) => void;
}) {
  const pickerKeyDownRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const pickerSyncRef = useRef<(ed: Editor) => void>(() => {});
  const pickerCloseRef = useRef<() => void>(() => {});

  const saveDebounced = useMemo(
    () =>
      debounce((md: string) => {
        void saveDailyDraft(md);
      }, 400),
    [],
  );

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: "mochi-link" },
        },
      }),
      UnderlineExtension,
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
      ClipboardSerialize,
      Placeholder.configure({
        placeholder:
          "Today… (type, separate entries with --- ; #tags become tags)",
        showOnlyWhenEditable: true,
      }),
      Hashtag.configure({ getTags: () => [] }),
      FindInNote,
      SlashMenu,
    ],
    content: initial,
    autofocus: "end",
    editorProps: {
      handleKeyDown(_view, event) {
        return pickerKeyDownRef.current(event);
      },
    },
    onUpdate: ({ editor }) => {
      pickerSyncRef.current(editor);
      saveDebounced(getMarkdownPreservingEmptyParas(editor));
    },
    onSelectionUpdate: ({ editor }) => {
      rememberSelection(editor);
      pickerSyncRef.current(editor);
    },
    onFocus: ({ editor }) => {
      setActiveEditor(editor);
      rememberFocus(editor);
    },
    onBlur: ({ editor }) => {
      saveDebounced(getMarkdownPreservingEmptyParas(editor));
      saveDebounced.flush();
      clearActiveEditorIf(editor);
      pickerCloseRef.current();
    },
  });

  const picker = useHashtagPicker(editor);
  useEffect(() => {
    pickerKeyDownRef.current = picker.handleKeyDown;
    pickerSyncRef.current = picker.sync;
    pickerCloseRef.current = picker.close;
  }, [picker.handleKeyDown, picker.sync, picker.close]);

  useEffect(() => () => saveDebounced.flush(), [saveDebounced]);

  const flushNow = async () => {
    if (!editor) return;
    const md = getMarkdownPreservingEmptyParas(editor);
    saveDebounced.cancel();
    const n = await flushDailyDraft(md);
    await clearDailyDraft();
    editor.commands.clearContent();
    editor.commands.focus();
    setFlushMsg(
      n === 0
        ? "Nothing to add."
        : `Added ${n} block${n === 1 ? "" : "s"} to your notes.`,
    );
    window.setTimeout(() => setFlushMsg(null), 3000);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 text-sm">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">
          Daily note
        </span>
        <span className="text-neutral-400">{todayStr()}</span>
        {flushMsg && (
          <span className="text-xs text-green-600 dark:text-green-400">
            {flushMsg}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => void flushNow()}
            title="Split on horizontal rules and add each entry to your notes"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <CornerDownRight size={13} /> Add to notes
          </button>
          <button
            onClick={onClose}
            title="Back to notes"
            className="text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 text-xs"
          >
            Close
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-10 pt-8 pb-32 text-base leading-relaxed mochi-expanded-editor">
          <BlockBubbleMenu editor={editor} />
          <EditorContent editor={editor} />
          {picker.dropdown}
        </div>
      </div>
    </div>
  );
}

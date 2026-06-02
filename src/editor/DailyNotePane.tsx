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
import { ipc } from "../lib/ipc";
import {
  getMarkdownPreservingEmptyParas,
  serializeFragmentPreservingEmptyParas,
} from "../lib/markdown";
import { debounce } from "../lib/debounce";
import {
  todayStr,
  dailyDateLabel,
  splitDailyIntoSegments,
  flushSegmentsToBlocks,
} from "../lib/daily";
import { DailyFlushModal } from "./DailyFlushModal";
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

// Session-scoped scroll memory per daily-note date, so reopening a day
// returns to where you left off instead of jumping to the bottom.
const scrollByDate = new Map<string, number>();

/**
 * Daily note for a specific date, rendered full-screen in the main panel.
 * Loads that day's saved markdown, autosaves edits back to it, and offers
 * "Add to notes" (split on horizontal rules → canvas blocks; #hashtags →
 * tags). Past days are read/editable too — nothing is destroyed. Carries
 * the same `#` autocomplete as the note editor.
 */
export function DailyNotePane({ date }: { date: string }) {
  const [initial, setInitial] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setInitial(null);
    ipc
      .getDailyNote(date)
      .then((c) => {
        if (!cancelled) setInitial(c);
      })
      .catch(() => {
        if (!cancelled) setInitial("");
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  if (initial === null) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-neutral-400">
        Loading…
      </div>
    );
  }

  return <DailyEditor key={date} date={date} initial={initial} />;
}

function DailyEditor({
  date,
  initial,
}: {
  date: string;
  initial: string;
}) {
  const [flushMsg, setFlushMsg] = useState<string | null>(null);
  // Segments awaiting selection in the "Add to notes" modal (null = closed).
  const [flushSegments, setFlushSegments] = useState<string[] | null>(null);
  const pickerKeyDownRef = useRef<(e: KeyboardEvent) => boolean>(() => false);
  const pickerSyncRef = useRef<(ed: Editor) => void>(() => {});
  const pickerCloseRef = useRef<() => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  // If we've seen this date before, restore its scroll instead of
  // autofocusing to the end (which would jump to the bottom).
  const hasSavedScroll = scrollByDate.has(date);

  const saveDebounced = useMemo(
    () =>
      debounce((md: string) => {
        void ipc.saveDailyNote(date, md).then(() => {
          window.dispatchEvent(new Event("mochi:daily-saved"));
        });
      }, 400),
    [date],
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
            "Today… (separate entries with --- ; #tags become tags)",
          showOnlyWhenEditable: true,
        }),
        Hashtag.configure({ getTags: () => [] }),
        FindInNote,
        SlashMenu,
      ],
      content: initial,
      autofocus: date === todayStr() && !hasSavedScroll ? "end" : false,
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

  // Restore the remembered scroll for this date on mount; persist the
  // latest scroll on unmount (the onScroll handler keeps it fresh too).
  useEffect(() => {
    const el = scrollRef.current;
    const saved = scrollByDate.get(date);
    if (el && saved != null) {
      requestAnimationFrame(() => {
        el.scrollTop = saved;
      });
    }
    return () => {
      if (scrollRef.current) {
        scrollByDate.set(date, scrollRef.current.scrollTop);
      }
    };
  }, [date]);

  // Open the picker modal. When there's a text selection, only that part
  // is offered; otherwise the whole note. Either way it's split on "---".
  const openFlush = () => {
    if (!editor) return;
    const sel = editor.state.selection;
    const md = sel.empty
      ? getMarkdownPreservingEmptyParas(editor)
      : serializeFragmentPreservingEmptyParas(editor, sel.content().content);
    const segs = splitDailyIntoSegments(md);
    if (segs.length === 0) {
      setFlushMsg("Nothing to add (write something, separate entries with ---).");
      window.setTimeout(() => setFlushMsg(null), 3000);
      return;
    }
    setFlushSegments(segs);
  };

  const confirmFlush = async (selected: string[]) => {
    setFlushSegments(null);
    const n = await flushSegmentsToBlocks(selected);
    setFlushMsg(`Added ${n} block${n === 1 ? "" : "s"} to your notes.`);
    window.setTimeout(() => setFlushMsg(null), 3000);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-3 text-sm">
        <span className="font-medium text-neutral-700 dark:text-neutral-200">
          {dailyDateLabel(date)}
        </span>
        <span className="text-neutral-400">{date}</span>
        {flushMsg && (
          <span className="text-xs text-green-600 dark:text-green-400">
            {flushMsg}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={openFlush}
            title="Pick which entries (split on ---) to add to your notes; select text first to add just that part"
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <CornerDownRight size={13} /> Add to notes
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={(e) => scrollByDate.set(date, e.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-10 pt-8 pb-32 text-base leading-relaxed mochi-expanded-editor">
          <BlockBubbleMenu editor={editor} />
          <EditorContent editor={editor} />
          {picker.dropdown}
        </div>
      </div>
      {flushSegments && (
        <DailyFlushModal
          segments={flushSegments}
          onClose={() => setFlushSegments(null)}
          onConfirm={confirmFlush}
        />
      )}
    </div>
  );
}

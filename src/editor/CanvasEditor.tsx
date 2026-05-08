import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import { useWorkspace } from "../stores/workspace";
import { jsonFromBlocks, snapshotBlocks } from "../lib/markdown";
import { debounce } from "../lib/debounce";
import { MochiDocument } from "./extensions/Document";
import { Block } from "./extensions/Block";
import { KeyboardActions } from "./extensions/KeyboardActions";
import { Hashtag } from "./extensions/Hashtag";
import { HashtagHighlight } from "./extensions/HashtagHighlight";
import { SlashMenu } from "./extensions/SlashMenu";
import { CanvasLasso } from "./extensions/CanvasLasso";
import { BlockDragHandle } from "./extensions/BlockDragHandle";
import { ClipboardSerialize } from "./extensions/ClipboardSerialize";
import { BlockBubbleMenu } from "./BubbleMenu";
import { VersionHistoryModal } from "./VersionHistoryModal";
import { setCanvasEditor } from "./editorRef";

export function CanvasEditor() {
  const blocks = useWorkspace((s) => s.blocks);
  const tags = useWorkspace((s) => s.tags);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);

  const [historyId, expandHistory] = useState<string | null>(null);

  const tagsRef = useRef(tags);
  useEffect(() => { tagsRef.current = tags; }, [tags]);
  const initializedRef = useRef(false);
  const lastBlockOrderRef = useRef("");
  // IDs the editor knew about at the last save. We diff against this to
  // produce the deleted_ids list — the DB layer detects content changes
  // itself, so we don't need per-block hash tracking on the frontend.
  const knownIdsRef = useRef<Set<string>>(new Set());

  const editor = useEditor({
    extensions: [
      MochiDocument,
      StarterKit.configure({
        document: false,
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { class: "mochi-link" },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, linkify: true, breaks: false }),
      Placeholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === "heading") return "Heading";
          if (node.type.name === "paragraph") return "Type / for commands";
          return "";
        },
        includeChildren: true,
      }),
      Block,
      Hashtag.configure({
        getTags: () => tagsRef.current.map((t) => t.tag),
      }),
      HashtagHighlight,
      SlashMenu,
      CanvasLasso,
      BlockDragHandle,
      ClipboardSerialize,
      KeyboardActions,
    ],
    content: "",
    onUpdate: ({ editor }) => {
      if (!initializedRef.current) return;
      saveDebounced(editor);
    },
  });

  const saveDebounced = useMemo(
    () =>
      debounce(async (editorInst: any) => {
        const snapshot = snapshotBlocks(editorInst);
        const currentIds = new Set(snapshot.map((b) => b.id));
        const deleted: string[] = [];
        for (const prior of knownIdsRef.current) {
          if (!currentIds.has(prior)) deleted.push(prior);
        }
        knownIdsRef.current = currentIds;
        await saveSnapshot(snapshot, deleted);
      }, 300),
    [saveSnapshot],
  );

  useEffect(() => {
    setCanvasEditor(editor ?? null);
    return () => setCanvasEditor(null);
  }, [editor]);

  // Load / reload editor content when the block list changes from outside
  // (initial load, agent edit, restore-from-backup). Self-triggered saves
  // don't change the order signature, so the editor isn't reloaded mid-edit.
  useEffect(() => {
    if (!editor) return;
    if (blocks.length === 0 && !initializedRef.current) return;
    const orderSig = blocks.map((b) => `${b.id}:${b.content_hash}`).join("|");
    if (initializedRef.current && orderSig === lastBlockOrderRef.current) return;

    if (initializedRef.current) {
      // If the editor's current doc already matches (e.g. the change came
      // from a sidebar drag that dispatched a transaction), just refresh
      // the cached signature and skip the reload.
      const editorSig: string[] = [];
      editor.state.doc.forEach((n: any) => {
        if (n.type.name === "mochiBlock" && n.attrs.id) {
          const stored = blocks.find((b) => b.id === n.attrs.id);
          editorSig.push(`${n.attrs.id}:${stored?.content_hash ?? ""}`);
        }
      });
      if (editorSig.join("|") === orderSig) {
        lastBlockOrderRef.current = orderSig;
        knownIdsRef.current = new Set(blocks.map((b) => b.id));
        return;
      }
    }

    // Don't clobber an in-flight edit.
    if (initializedRef.current && editor.isFocused) {
      lastBlockOrderRef.current = orderSig;
      return;
    }

    const json = jsonFromBlocks(editor, blocks);
    editor.commands.setContent(json, { emitUpdate: false });
    initializedRef.current = true;
    lastBlockOrderRef.current = orderSig;
    knownIdsRef.current = new Set(blocks.map((b) => b.id));
  }, [editor, blocks]);

  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (id) expandHistory(id);
    };
    window.addEventListener("mochi:show-history", handler);
    return () => window.removeEventListener("mochi:show-history", handler);
  }, []);

  return (
    <div className="flex-1 overflow-y-auto px-6 pt-6 pb-32 cursor-text relative">
      <div className="max-w-3xl mx-auto">
        <BlockBubbleMenu editor={editor} />
        <EditorContent editor={editor} />
      </div>

      {historyId && (
        <VersionHistoryModal blockId={historyId} onClose={() => expandHistory(null)} />
      )}
    </div>
  );
}

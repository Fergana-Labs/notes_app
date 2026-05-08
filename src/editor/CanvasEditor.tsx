import { useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { Markdown } from "tiptap-markdown";
import { useWorkspace } from "../stores/workspace";
import type { StoredBlock } from "../lib/ipc";
import {
  jsonFromBlocks,
  snapshotBlockById,
  snapshotBlocks,
} from "../lib/markdown";
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
import { FastPlaceholder } from "./extensions/FastPlaceholder";
import { BlockBubbleMenu } from "./BubbleMenu";
import { VersionHistoryModal } from "./VersionHistoryModal";
import { setCanvasEditor } from "./editorRef";

type SnapshotBlock = ReturnType<typeof snapshotBlocks>[number];

function sameSnapshotBlock(a: SnapshotBlock | undefined, b: SnapshotBlock) {
  return (
    !!a &&
    a.content === b.content &&
    a.position === b.position &&
    (a.parent_id ?? null) === (b.parent_id ?? null) &&
    (a.heading ?? null) === (b.heading ?? null) &&
    (a.heading_level ?? null) === (b.heading_level ?? null)
  );
}

function snapshotsMatchBlocks(snapshot: SnapshotBlock[], blocks: StoredBlock[]) {
  if (snapshot.length !== blocks.length) return false;
  for (let i = 0; i < snapshot.length; i++) {
    const s = snapshot[i];
    const b = blocks[i];
    if (
      !b ||
      s.id !== b.id ||
      s.content !== b.content ||
      s.position !== b.position ||
      (s.parent_id ?? null) !== (b.parent_id ?? null) ||
      (s.heading ?? null) !== (b.heading ?? null) ||
      (s.heading_level ?? null) !== (b.heading_level ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function blockIdsTouchedByTransaction(editor: any, transaction: any): Set<string> {
  const ids = new Set<string>();
  const doc = editor.state.doc;
  const addAtPos = (pos: number) => {
    const clamped = Math.max(0, Math.min(doc.content.size, pos));
    const $pos = doc.resolve(clamped);
    for (let depth = $pos.depth; depth > 0; depth--) {
      const node = $pos.node(depth);
      if (node.type.name === "mochiBlock" && node.attrs.id) {
        ids.add(node.attrs.id);
        return;
      }
    }
  };

  transaction.mapping.maps.forEach((stepMap: any) => {
    stepMap.forEach(
      (_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
        const from = Math.max(0, Math.min(doc.content.size, newStart));
        const to = Math.max(from, Math.min(doc.content.size, newEnd));
        if (from === to) {
          addAtPos(from);
          if (from > 0) addAtPos(from - 1);
          return;
        }
        doc.nodesBetween(from, to, (node: any) => {
          if (node.type.name !== "mochiBlock" || !node.attrs.id) return true;
          ids.add(node.attrs.id);
          return false;
        });
      },
    );
  });

  return ids;
}

export function CanvasEditor() {
  const blocks = useWorkspace((s) => s.blocks);
  const tags = useWorkspace((s) => s.tags);
  const saveSnapshot = useWorkspace((s) => s.saveSnapshot);

  const [historyId, expandHistory] = useState<string | null>(null);

  const tagsRef = useRef(tags);
  useEffect(() => { tagsRef.current = tags; }, [tags]);
  const initializedRef = useRef(false);
  const lastBlockOrderRef = useRef("");
  // Map of block id to the last successfully saved snapshot. Used to filter
  // saves to only blocks whose content or structural metadata changed. On a
  // 2k-block doc, a one-character edit becomes a 1-block save instead of a
  // 2k-block save, while reorders still persist position changes.
  const lastSavedRef = useRef<Map<string, SnapshotBlock>>(new Map());
  const dirtyIdsRef = useRef<Set<string>>(new Set());
  const forceFullSaveRef = useRef(false);

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
      FastPlaceholder.configure({
        placeholder: ({ node }) => {
          if (node.type.name === "heading") return "Heading";
          if (node.type.name === "paragraph") return "Type / for commands";
          return "";
        },
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
    onUpdate: ({ editor, transaction }: any) => {
      if (!initializedRef.current) return;
      if (transaction?.docChanged) {
        const beforeChildCount = transaction.before?.childCount;
        if (
          typeof beforeChildCount === "number" &&
          beforeChildCount !== editor.state.doc.childCount
        ) {
          forceFullSaveRef.current = true;
        }

        const touched = blockIdsTouchedByTransaction(editor, transaction);
        if (touched.size === 0 || touched.size > 1) {
          forceFullSaveRef.current = true;
        }
        for (const id of touched) dirtyIdsRef.current.add(id);
      }
      saveDebounced(editor);
    },
  });

  const saveDebounced = useMemo(
    () =>
      debounce(async (editorInst: any) => {
        const known = lastSavedRef.current;
        const dirtyIds = Array.from(dirtyIdsRef.current);
        const forceFull = forceFullSaveRef.current;

        if (!forceFull && dirtyIds.length === 0) return;

        let snapshot: SnapshotBlock[] = [];
        let fullSnapshot = forceFull || dirtyIds.length > 20;

        if (!fullSnapshot) {
          for (const id of dirtyIds) {
            const prior = known.get(id);
            const b = snapshotBlockById(
              editorInst,
              id,
              prior?.parent_id ?? null,
            );
            if (!b || (prior && b.heading_level !== prior.heading_level)) {
              fullSnapshot = true;
              break;
            }
            snapshot.push(b);
          }
        }

        if (fullSnapshot) {
          snapshot = snapshotBlocks(editorInst);
        }

        // Filter to blocks whose content or structural metadata changed since
        // the last successful save, plus brand-new blocks.
        const dirty: typeof snapshot = [];
        const seen = new Set<string>();
        for (const b of snapshot) {
          seen.add(b.id);
          if (!sameSnapshotBlock(known.get(b.id), b)) dirty.push(b);
        }

        const deleted: string[] = [];
        if (fullSnapshot) {
          for (const id of known.keys()) {
            if (!seen.has(id)) deleted.push(id);
          }
        }

        if (dirty.length === 0 && deleted.length === 0) {
          dirtyIdsRef.current.clear();
          forceFullSaveRef.current = false;
          return;
        }

        dirtyIdsRef.current.clear();
        forceFullSaveRef.current = false;

        try {
          await saveSnapshot(dirty, deleted);
        } catch (e) {
          for (const id of dirtyIds) dirtyIdsRef.current.add(id);
          if (fullSnapshot) forceFullSaveRef.current = true;
          throw e;
        }

        // Refresh the cache only on success — that way a transient save
        // failure stays "dirty" and retries on the next edit.
        const next = fullSnapshot
          ? new Map<string, SnapshotBlock>()
          : new Map(known);
        for (const b of snapshot) next.set(b.id, b);
        for (const id of deleted) next.delete(id);
        lastSavedRef.current = next;
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

    // Don't clobber an in-flight edit. This is also the common path after our
    // own debounced canvas save updates the workspace store; avoid a full
    // editor snapshot while the user is actively typing.
    if (initializedRef.current && editor.isFocused) {
      lastBlockOrderRef.current = orderSig;
      return;
    }

    if (initializedRef.current) {
      // If the editor's current doc already matches (e.g. the change came
      // from our own debounced save or a sidebar drag that already dispatched
      // a transaction), refresh the signatures and skip the expensive reload.
      const editorSnapshot = snapshotBlocks(editor);
      if (snapshotsMatchBlocks(editorSnapshot, blocks)) {
        lastBlockOrderRef.current = orderSig;
        lastSavedRef.current = new Map(editorSnapshot.map((b) => [b.id, b]));
        return;
      }
    }

    const json = jsonFromBlocks(editor, blocks);
    editor.commands.setContent(json, { emitUpdate: false });
    initializedRef.current = true;
    lastBlockOrderRef.current = orderSig;
    lastSavedRef.current = new Map(snapshotBlocks(editor).map((b) => [b.id, b]));
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

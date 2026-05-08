import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Combine,
  Trash2,
  GripVertical,
  AlignVerticalSpaceAround,
  SplitSquareVertical,
} from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { ipc, type StoredBlock, type BlockInput } from "../lib/ipc";
import { useWorkspace } from "../stores/workspace";
import { debounce } from "../lib/debounce";
import { getCanvasEditor } from "../editor/editorRef";

interface Props {
  tag: string;
  onClose: () => void;
}

function asBlockInput(b: StoredBlock, override?: Partial<BlockInput>): BlockInput {
  return {
    id: b.id,
    content: override?.content ?? b.content,
    position: override?.position ?? b.position,
    parent_id: override?.parent_id ?? b.parent_id,
    heading: override?.heading ?? b.heading,
    heading_level: override?.heading_level ?? b.heading_level,
  };
}

export function TagPage({ tag, onClose }: Props) {
  const blocks = useWorkspace((s) => s.blocks);
  const reload = useWorkspace((s) => s.reload);
  const setBlockTags = useWorkspace((s) => s.setBlockTags);

  const tagged = useMemo(
    () => blocks.filter((b) => b.tags.includes(tag.toLowerCase())),
    [blocks, tag],
  );

  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    setOrder((prev) => {
      const existing = prev.filter((id) => tagged.find((b) => b.id === id));
      const newOnes = tagged.filter((b) => !existing.includes(b.id)).map((b) => b.id);
      return [...existing, ...newOnes];
    });
  }, [tagged]);

  const ordered = order.map((id) => tagged.find((b) => b.id === id)).filter(Boolean) as StoredBlock[];

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(String(active.id));
    const to = order.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, String(active.id));
    setOrder(next);
  };

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /**
   * Merge selected blocks into the first one and delete the rest. One
   * `save_blocks` call carries both the upsert (kept block with merged
   * content) and the deletions.
   */
  const combineSelected = async () => {
    const ids = order.filter((id) => selected.has(id));
    if (ids.length < 2) return;
    const keep = blocks.find((b) => b.id === ids[0]);
    if (!keep) return;

    const chunks = ids.map((id) => blocks.find((b) => b.id === id)?.content ?? "");
    const merged = chunks.join("\n\n");

    await ipc.saveBlocks(
      [asBlockInput(keep, { content: merged })],
      ids.slice(1),
      "tag-page",
    );
    await reload();
    setSelected(new Set());
  };

  const removeFromTag = async (id: string) => {
    const b = tagged.find((x) => x.id === id);
    if (!b) return;
    const next = b.tags.filter((t) => t !== tag.toLowerCase());
    await setBlockTags(id, next, true);
  };

  const groupOnCanvas = () => {
    const editor = getCanvasEditor();
    if (!editor) return;

    const taggedIds = order;
    if (taggedIds.length === 0) return;
    const taggedSet = new Set(taggedIds);

    const doc = editor.state.doc;
    const all: { id: string; node: any }[] = [];
    doc.forEach((n) => {
      if (n.type.name === "mochiBlock" && n.attrs.id) {
        all.push({ id: n.attrs.id, node: n });
      }
    });

    const firstIdx = all.findIndex((b) => taggedSet.has(b.id));
    if (firstIdx < 0) return;

    const before = all.slice(0, firstIdx).filter((b) => !taggedSet.has(b.id));
    const after = all.slice(firstIdx).filter((b) => !taggedSet.has(b.id));
    const taggedNodes = taggedIds
      .map((id) => all.find((b) => b.id === id))
      .filter(Boolean) as { id: string; node: any }[];

    const newContent = [
      ...before.map((b) => b.node),
      ...taggedNodes.map((b) => b.node),
      ...after.map((b) => b.node),
    ];
    const tr = editor.state.tr.replaceWith(0, doc.content.size, newContent);
    editor.view.dispatch(tr);
  };

  const splitSelectedIntoLines = async () => {
    const editor = getCanvasEditor();
    if (!editor) return;
    const ids = order.filter((id) => selected.has(id));
    if (ids.length === 0) return;

    const doc = editor.state.doc;
    const blockType = editor.schema.nodes.mochiBlock;
    if (!blockType) return;

    let tr = editor.state.tr;
    const targets: { pos: number; node: any }[] = [];
    doc.forEach((n, offset) => {
      if (n.type.name === "mochiBlock" && ids.includes(n.attrs.id)) {
        targets.push({ pos: offset, node: n });
      }
    });
    targets.reverse();

    for (const { pos, node } of targets) {
      const newBlocks: any[] = [];
      let first = true;
      node.descendants((d: any) => {
        if (d.type.name === "paragraph" || d.type.name === "heading") {
          if (d.textContent.length === 0 && newBlocks.length > 0) return false;
          const attrs = first ? node.attrs : {};
          first = false;
          newBlocks.push(blockType.create(attrs, d));
          return false;
        }
        return true;
      });
      if (newBlocks.length <= 1) continue;
      tr = tr.replaceWith(pos, pos + node.nodeSize, newBlocks);
    }
    editor.view.dispatch(tr);
    setSelected(new Set());
  };

  return (
    <div className="flex-1 overflow-y-auto px-6 py-6">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-4">
          <button
            onClick={onClose}
            className="flex items-center gap-1 text-sm text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
          >
            <ArrowLeft size={16} /> Canvas
          </button>
          <h1 className="text-2xl font-bold">#{tag}</h1>
          <span className="text-sm text-neutral-500">
            {tagged.length} block{tagged.length === 1 ? "" : "s"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {selected.size >= 1 && (
              <button
                onClick={splitSelectedIntoLines}
                title="Split each selected block into one block per paragraph / list item"
                className="flex items-center gap-1 text-sm px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <SplitSquareVertical size={14} /> Split{" "}
                {selected.size > 1 ? selected.size : ""}
              </button>
            )}
            {selected.size >= 2 && (
              <button
                onClick={combineSelected}
                className="flex items-center gap-1 text-sm px-2 py-1 rounded bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
              >
                <Combine size={14} /> Combine {selected.size}
              </button>
            )}
            {tagged.length >= 2 && (
              <button
                onClick={groupOnCanvas}
                title="Move all tagged blocks to be contiguous on the canvas, in this order"
                className="flex items-center gap-1 text-sm px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                <AlignVerticalSpaceAround size={14} /> Group on canvas
              </button>
            )}
          </div>
        </div>

        {ordered.length === 0 && (
          <p className="text-sm text-neutral-500 italic">No blocks tagged with #{tag}.</p>
        )}

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            {ordered.map((b) => (
              <TagChunk
                key={b.id}
                block={b}
                tag={tag}
                selected={selected.has(b.id)}
                onSelect={() => toggleSelect(b.id)}
                onRemove={() => removeFromTag(b.id)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

function TagChunk({
  block,
  tag,
  selected,
  onSelect,
  onRemove,
}: {
  block: StoredBlock;
  tag: string;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const reload = useWorkspace((s) => s.reload);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const editor = useEditor({
    extensions: [StarterKit, Markdown.configure({ html: false, linkify: true })],
    content: block.content,
    onUpdate: ({ editor }) => {
      const md: string = (editor.storage as any).markdown.getMarkdown();
      saveDebounced(md);
    },
  });

  const saveDebounced = useMemo(
    () =>
      debounce(async (md: string) => {
        await ipc.saveBlocks([asBlockInput(block, { content: md })], [], "tag-page");
        await reload();
      }, 600),
    [block, reload],
  );

  useEffect(() => () => saveDebounced.cancel(), [saveDebounced]);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}
      className="mb-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900"
    >
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-neutral-500 border-b border-neutral-100 dark:border-neutral-800">
        <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
          <GripVertical size={14} />
        </button>
        <input type="checkbox" checked={selected} onChange={onSelect} />
        <span className="font-mono text-[10px]">{block.id.slice(-8)}</span>
        {block.heading && <span className="truncate">— {block.heading}</span>}
        <button
          onClick={onRemove}
          className="ml-auto p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600"
          title={`Remove #${tag} from this block`}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="px-4 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

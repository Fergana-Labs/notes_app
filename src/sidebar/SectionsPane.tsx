import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspace } from "../stores/workspace";
import { descendantIds } from "../lib/markdown";
import type { StoredBlock } from "../lib/ipc";
import { getCanvasEditor } from "../editor/editorRef";

/**
 * The DIRECT (non-transitive) non-heading children of a heading — i.e. the
 * paragraphs / lists / etc. that belong specifically to this heading's
 * section, not those that belong to any of its sub-headings.
 */
function directNonHeadingChildren(
  blocks: StoredBlock[],
  headingId: string,
): string[] {
  return blocks
    .filter((b) => b.parent_id === headingId && b.heading_level == null)
    .map((b) => b.id);
}

export function SectionsPane({ onJump }: { onJump: (id: string) => void }) {
  // Subscribe to *only* the heading rows from `blocks`, with a shallow
  // equality check on the array. PM nodes are immutable and saveSnapshot
  // preserves StoredBlock references for unchanged blocks, so when the
  // user types in a non-heading block this filter returns the same set
  // of element references and `useShallow` skips the re-render entirely.
  // Without this, every save (~3/sec while typing) re-rendered the
  // entire SortableContext + 100s of `useSortable` hooks — multi-hundred-
  // millisecond cost that masqueraded as paint delay in the keystroke
  // profiler.
  const headings = useWorkspace(
    useShallow((s) => s.blocks.filter((b) => b.heading_level != null)),
  );
  // `handleDragEnd` needs the full block list for descendant lookup, but
  // that path is only taken on drop. Read via `getState()` inside the
  // handler so this component doesn't re-render when non-heading content
  // changes (the whole point of the `useShallow` heading subscription).
  const getBlocks = () => useWorkspace.getState().blocks;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const activeId = String(active.id);
    const overId = String(over.id);

    const ids = headings.map((h) => h.id);
    const oldIndex = ids.indexOf(activeId);
    const newIndex = ids.indexOf(overId);
    if (oldIndex < 0 || newIndex < 0) return;

    const newHeadingOrder = arrayMove(ids, oldIndex, newIndex);

    const editor = getCanvasEditor();
    if (!editor) return;

    const blocks = getBlocks();

    // The dragged heading carries its entire transitive subtree
    // (sub-headings + everything beneath them). Other headings just take
    // their own direct paragraphs.
    const activeOwnership = new Set<string>([
      activeId,
      ...descendantIds(blocks, activeId),
    ]);

    const orphanIds = blocks
      .filter((b) => b.parent_id == null && b.heading_level == null)
      .map((b) => b.id);

    const newBlockOrder: string[] = [...orphanIds];
    for (const hid of newHeadingOrder) {
      if (hid === activeId) {
        // Insert the whole moved subtree, preserving its original order.
        for (const b of blocks) {
          if (activeOwnership.has(b.id)) newBlockOrder.push(b.id);
        }
      } else if (activeOwnership.has(hid)) {
        // Sub-heading travelling with the active heading — already covered.
        continue;
      } else {
        newBlockOrder.push(hid);
        newBlockOrder.push(...directNonHeadingChildren(blocks, hid));
      }
    }

    const doc = editor.state.doc;
    const byId = new Map<string, any>();
    doc.forEach((node) => {
      if (node.type.name === "mochiBlock" && node.attrs.id) {
        byId.set(node.attrs.id, node);
      }
    });

    const newContent = newBlockOrder
      .map((id) => byId.get(id))
      .filter(Boolean);
    if (newContent.length === 0) return;

    const tr = editor.state.tr.replaceWith(0, doc.content.size, newContent);
    editor.view.dispatch(tr);
  };

  if (headings.length === 0) {
    return (
      <p className="p-3 text-xs text-neutral-500 italic">
        No headings yet. Start a block with # for a section.
      </p>
    );
  }

  return (
    <div className="p-2">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={headings.map((h) => h.id)}
          strategy={verticalListSortingStrategy}
        >
          <ul className="space-y-0.5">
            {headings.map((h) => (
              <SortableHeading key={h.id} block={h} onJump={onJump} />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function SortableHeading({
  block,
  onJump,
}: {
  block: StoredBlock;
  onJump: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const level = block.heading_level ?? 1;
  // Indent sub-headings: h1 = 0, h2 = 12px, h3 = 24px, etc.
  const indent = (level - 1) * 12;

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
    >
      <button
        {...attributes}
        {...listeners}
        className="px-1 py-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 cursor-grab active:cursor-grabbing shrink-0 invisible group-hover:visible"
        title="Drag to reorder"
        aria-label="Drag handle"
      >
        <GripVertical size={14} />
      </button>
      <button
        onClick={() => onJump(block.id)}
        className="flex-1 text-left text-sm py-1 truncate min-w-0"
        style={{ paddingLeft: indent }}
        title={block.heading ?? ""}
      >
        <span className="text-neutral-400 mr-1">{"#".repeat(level)}</span>
        {block.heading}
      </button>
    </li>
  );
}

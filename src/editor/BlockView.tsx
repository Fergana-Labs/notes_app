import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { GripVertical, Plus } from "lucide-react";
import { memo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { TextSelection } from "@tiptap/pm/state";
import { BlockMenu } from "./BlockMenu";
import { BLOCK_TYPES } from "./blockTypes";
import type { StoredBlock } from "../lib/ipc";
import { splitMochiBlockAtSelection } from "./extensions/splitBlock";

function runSplit(editor: any, state: any, _blockPos: number, _node: any) {
  splitMochiBlockAtSelection(editor, state);
}

/** Count of leaf-level textblocks (paragraphs, headings) inside a node. */
function countLeafTextblocks(node: any): number {
  let n = 0;
  node.descendants((d: any) => {
    if (d.type.name === "paragraph" || d.type.name === "heading") {
      if (d.textContent.length > 0 || n === 0) n++;
      return false;
    }
    return true;
  });
  return n;
}

/**
 * React NodeView for the `mochiBlock` schema node. Renders the chrome around
 * the editable content: a left-side gutter (`+` insert + grip drag handle)
 * and the inner `<NodeViewContent>`.
 *
 * Wrapped in `React.memo` below — see `BlockView` (the exported binding) for
 * the comparator. ProseMirror nodes are immutable, so when the doc changes
 * only the modified mochiBlock gets a new `node` reference; siblings keep
 * their previous reference and skip re-render entirely. This is the single
 * biggest perf win for many-block documents (2k+ blocks) — without memo,
 * every keystroke would re-render every BlockView.
 */
function BlockViewInner(props: NodeViewProps) {
  const { node, editor, getPos } = props;
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);

  const inner = node.firstChild;
  const innerName = inner?.type.name;
  const headingLevel: number | null =
    innerName === "heading" ? (inner?.attrs.level ?? null) : null;
  const activeBlockTypeId = (() => {
    if (headingLevel != null) return `h${headingLevel}`;
    switch (innerName) {
      case "bulletList": return "bullet";
      case "orderedList": return "numbered";
      case "taskList": return "todo";
      case "codeBlock": return "code";
      case "blockquote": return "quote";
      default: return "paragraph";
    }
  })();

  // Header chrome lives at the top of the card, so the gutter sits flush
  // with the avatar row — no per-heading offset needed.
  const handle = (node.attrs.id ?? "").slice(-6).toLowerCase() || "block";
  const avatarColor = avatarColorFromId(node.attrs.id ?? "");
  const avatarInitial = handle.slice(0, 1).toUpperCase();

  const insertBlockBelow = () => {
    const pos = getPos?.();
    if (typeof pos !== "number") return;
    const insertPos = pos + node.nodeSize;
    const blockType = editor.schema.nodes.mochiBlock;
    const paraType = editor.schema.nodes.paragraph;
    if (!blockType || !paraType) return;
    const newNode = blockType.create({}, paraType.create());
    const tr = editor.state.tr.insert(insertPos, newNode);
    // Cursor inside the empty paragraph of the new block.
    const sel = TextSelection.create(tr.doc, insertPos + 2);
    tr.setSelection(sel);
    editor.view.dispatch(tr);
    editor.commands.focus();
  };

  const openMenuFromGrip = (e: ReactMouseEvent<HTMLButtonElement>) => {
    setMenuAnchor(e.currentTarget.getBoundingClientRect());
  };

  const onContextMenu = (e: ReactMouseEvent) => {
    e.preventDefault();
    setMenuAnchor(new DOMRect(e.clientX, e.clientY, 0, 0));
  };

  const blockObj: StoredBlock = {
    id: node.attrs.id ?? "",
    parent_id: null,
    position: 0,
    heading: headingLevel != null ? inner?.textContent ?? null : null,
    heading_level: headingLevel,
    content: "",
    content_hash: "",
    tags: Array.isArray(node.attrs.tags) ? node.attrs.tags : [],
    manual_tags: !!node.attrs.manualTags,
    created_at: 0,
    updated_at: 0,
  };

  const showMenuActions = {
    delete: () => {
      const pos = getPos?.();
      if (typeof pos !== "number") return;
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.delete(pos, pos + node.nodeSize);
          return true;
        })
        .run();
    },
    duplicate: () => {
      const pos = getPos?.();
      if (typeof pos !== "number") return;
      const copy = node.type.create(
        { ...node.attrs, id: null }, // id will be re-minted by the plugin
        node.content,
      );
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.insert(pos + node.nodeSize, copy);
          return true;
        })
        .run();
    },
    copyMarkdown: async () => {
      const serializer = (editor.storage as any).markdown?.serializer;
      if (!serializer || node.childCount === 0) return;
      try {
        // Serialize each block-level child and join with blank lines.
        const parts: string[] = [];
        node.content.forEach((child) => {
          parts.push(serializer.serialize(child));
        });
        await navigator.clipboard.writeText(parts.join("\n\n"));
      } catch {
        // ignore
      }
    },
    copyId: async () => {
      try {
        await navigator.clipboard.writeText(node.attrs.id ?? "");
      } catch {
        // ignore
      }
    },
    splitIntoBlocks: () => {
      // Split into one block per leaf textblock (paragraph / heading), so
      // that a bullet list with 3 items becomes 3 blocks, etc.
      const pos = getPos?.();
      if (typeof pos !== "number") return;
      const blockType = editor.schema.nodes.mochiBlock;
      const paraType = editor.schema.nodes.paragraph;
      if (!blockType) return;
      const newBlocks: any[] = [];
      let first = true;
      node.descendants((d: any) => {
        if (d.type.name === "paragraph" || d.type.name === "heading") {
          // Only emit non-empty leaves (skip placeholder empty paragraphs in
          // the middle of complex structures).
          if (d.textContent.length === 0 && newBlocks.length > 0) return false;
          const attrs = first ? node.attrs : {};
          first = false;
          // Wrap headings inside paragraphs are unusual — but we keep the
          // node as-is and let the schema accept it (heading is a valid
          // mochiBlock child).
          newBlocks.push(blockType.create(attrs, d));
          return false;
        }
        return true;
      });
      // If we walked the doc and ended up with zero blocks (e.g. block was
      // empty), fall back to a single paragraph-only block.
      if (newBlocks.length === 0 && paraType) {
        newBlocks.push(blockType.create(node.attrs, paraType.create()));
      }
      if (newBlocks.length <= 1) return;
      const tr = editor.state.tr.replaceWith(
        pos,
        pos + node.nodeSize,
        newBlocks,
      );
      editor.view.dispatch(tr);
    },
    splitAtCursor: () => {
      const blockPos = getPos?.();
      if (typeof blockPos !== "number") return;
      const { state } = editor;
      runSplit(editor, state, blockPos, node);
      editor.commands.focus();
    },
    turnInto: (typeId: string) => {
      const pos = getPos?.();
      if (typeof pos !== "number") return;
      const def = BLOCK_TYPES.find((b) => b.id === typeId);
      if (!def) return;
      const tr = editor.state.tr.setSelection(
        TextSelection.near(editor.state.doc.resolve(pos + 1), 1),
      );
      editor.view.dispatch(tr);
      def.apply(editor);
    },
  };

  return (
    <NodeViewWrapper
      className="mochi-block-row mochi-block-card group relative"
      data-block-id={node.attrs.id}
      data-heading-level={headingLevel ?? undefined}
      onContextMenu={onContextMenu}
    >
      <div
        contentEditable={false}
        className="mochi-block-header flex items-center gap-2 px-4 pt-3 select-none"
      >
        <div
          className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-semibold"
          style={{ background: avatarColor }}
          aria-hidden
        >
          {avatarInitial}
        </div>
        <div className="flex items-center gap-1.5 min-w-0 flex-1 text-xs text-neutral-500">
          <span className="font-mono truncate">@{handle}</span>
          {Array.isArray(node.attrs.tags) && node.attrs.tags.length > 0 && (
            <span className="flex items-center gap-1 flex-wrap">
              {(node.attrs.tags as string[]).slice(0, 4).map((t) => (
                <span
                  key={t}
                  className="px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                >
                  #{t}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-0.5">
          <button
            type="button"
            onClick={insertBlockBelow}
            title="Click to add a block below"
            className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Plus size={14} />
          </button>
          <button
            type="button"
            data-drag-handle
            onClick={openMenuFromGrip}
            title="Drag to move · click for menu"
            className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-grab active:cursor-grabbing"
          >
            <GripVertical size={14} />
          </button>
        </div>
      </div>

      <div className="mochi-block-body px-4 pt-1 pb-3 min-w-0">
        <NodeViewContent />
      </div>

      {menuAnchor && (
        <BlockMenu
          block={blockObj}
          editor={editor}
          isFirst={false /* we don't know without the doc, fine for now */}
          anchorRect={menuAnchor}
          canSplitIntoBlocks={countLeafTextblocks(node) > 1}
          activeBlockTypeId={activeBlockTypeId}
          onClose={() => setMenuAnchor(null)}
          onDelete={showMenuActions.delete}
          onDuplicate={showMenuActions.duplicate}
          onTurnInto={showMenuActions.turnInto}
          onSplitIntoBlocks={showMenuActions.splitIntoBlocks}
          onSplitAtCursor={showMenuActions.splitAtCursor}
          onMergeUp={() => {
            const pos = getPos?.();
            if (typeof pos !== "number" || pos === 0) return;
            // Join this block with its previous sibling.
            const tr = editor.state.tr;
            tr.join(pos);
            editor.view.dispatch(tr);
            editor.commands.focus();
          }}
          onShowHistory={() => {
            window.dispatchEvent(
              new CustomEvent("mochi:show-history", {
                detail: { id: node.attrs.id },
              }),
            );
          }}
          onCopyMarkdown={showMenuActions.copyMarkdown}
          onCopyId={showMenuActions.copyId}
        />
      )}
    </NodeViewWrapper>
  );
}

// Stable color from the block's ULID — same hue every render, same hue
// across sessions. Pure: never re-fires React.
function avatarColorFromId(id: string): string {
  if (!id) return "hsl(0deg 0% 60%)";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}deg 55% 50%)`;
}

export const BlockView = memo(BlockViewInner, (prev, next) => {
  // PM nodes are immutable, so reference equality is correct + cheap for
  // the node itself.
  if (prev.node !== next.node) return false;
  if (prev.selected !== next.selected) return false;
  // `decorations` is a fresh array on every Tiptap render, even when the
  // contained Decoration entries are reference-stable. Compare element-wise
  // — most blocks have an empty array, so this is the cheapest path most
  // of the time.
  const a = prev.decorations as unknown as unknown[];
  const b = next.decorations as unknown as unknown[];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
});

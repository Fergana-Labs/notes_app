import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { GripVertical, Plus } from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { TextSelection } from "@tiptap/pm/state";
import { BlockMenu } from "./BlockMenu";
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
 * the editable content: a left-side gutter (`+` insert + grip drag handle),
 * the inner `<NodeViewContent>`, and a tag-chip footer.
 */
export function BlockView(props: NodeViewProps) {
  const { node, editor, getPos } = props;
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null);

  const inner = node.firstChild;
  const innerName = inner?.type.name;
  const headingLevel: number | null =
    innerName === "heading" ? (inner?.attrs.level ?? null) : null;

  // Match the gutter's icon center with the first text line for any block type.
  const gutterPt = (() => {
    switch (headingLevel) {
      case 1: return 14;
      case 2: return 11;
      case 3: return 8;
      case 4:
      case 5:
      case 6: return 4;
      default: return 2;
    }
  })();

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
  };

  return (
    <NodeViewWrapper
      className="mochi-block-row group relative"
      data-block-id={node.attrs.id}
      onContextMenu={onContextMenu}
    >
      <div className="flex items-start py-0.5 rounded-md transition-colors">
        <div
          contentEditable={false}
          className="w-12 shrink-0 flex items-start justify-end gap-0 pr-1 opacity-0 group-hover:opacity-100 select-none"
          style={{ paddingTop: gutterPt }}
        >
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

        <div className="flex-1 min-w-0 pr-1">
          <NodeViewContent />
        </div>
      </div>

      {menuAnchor && (
        <BlockMenu
          block={blockObj}
          editor={editor}
          isFirst={false /* we don't know without the doc, fine for now */}
          anchorRect={menuAnchor}
          canSplitIntoBlocks={countLeafTextblocks(node) > 1}
          onClose={() => setMenuAnchor(null)}
          onDelete={showMenuActions.delete}
          onDuplicate={showMenuActions.duplicate}
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

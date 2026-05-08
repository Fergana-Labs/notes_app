import type { EditorState } from "@tiptap/pm/state";

/**
 * Split the mochiBlock containing the selection.
 *
 * Behaviour:
 *  - **No selection**: cursor splits the block in two. Empty halves are
 *    permitted (Cmd+Enter at the start/end of a block creates an empty
 *    sibling block, which is the natural "make a new block" gesture).
 *  - **Selection in the middle of a block**: 3-way split — `[before] [selected] [after]`.
 *  - **Selection at the start of the block**: 2-way split — `[selected] [after]`.
 *  - **Selection at the end of the block**: 2-way split — `[before] [selected]`.
 *  - **Selection covers the entire block**: no-op (nothing to split).
 *
 * "At the start/end" means the selection's start/end is at the start/end of
 * the mochiBlock's content (first text position of first child, or last text
 * position of last child) — so we never create empty leftover blocks when
 * the user just highlighted a tail or head of the original.
 */
export function splitMochiBlockAtSelection(editor: any, state: EditorState): boolean {
  const { selection } = state;
  const { $from, $to, from, to, empty } = selection;

  // Only split inside a paragraph / heading directly under a mochiBlock.
  const parent = $from.parent.type.name;
  if (parent !== "paragraph" && parent !== "heading") return false;

  let blockDepth = -1;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "mochiBlock") {
      blockDepth = d;
      break;
    }
  }
  if (blockDepth < 0) return false;

  const blockNode = $from.node(blockDepth);

  // Detect selection-at-start / selection-at-end relative to the WHOLE block,
  // not just the current paragraph (a multi-content block has multiple
  // children).
  const fromAtBlockStart =
    $from.index(blockDepth) === 0 && $from.parentOffset === 0;
  const toAtBlockEnd =
    $to.index(blockDepth) === blockNode.childCount - 1 &&
    $to.parentOffset === $to.parent.content.size;

  // Selection covers the whole block. Nothing to do.
  if (!empty && fromAtBlockStart && toAtBlockEnd) return true;

  let tr = state.tr;

  if (empty || from === to) {
    // Plain split at cursor.
    tr = tr.split(from, 2);
  } else if (fromAtBlockStart) {
    // [selected] [after]
    tr = tr.split(to, 2);
  } else if (toAtBlockEnd) {
    // [before] [selected]
    tr = tr.split(from, 2);
  } else {
    // [before] [selected] [after]
    tr = tr.split(to, 2);
    const mappedFrom = tr.mapping.map(from, -1);
    tr = tr.split(mappedFrom, 2);
  }

  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

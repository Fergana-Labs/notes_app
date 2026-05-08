import { Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { splitMochiBlockAtSelection } from "./splitBlock";

/**
 * Single-document keyboard shortcuts:
 *
 * - **Enter** in a paragraph or heading whose direct parent is a `mochiBlock`
 *   splits the mochiBlock at the cursor (creating two sibling blocks). Inside
 *   lists, code blocks, blockquote nesting, etc. — defers to Tiptap's default
 *   keymap so list-item/code-block behavior stays correct.
 * - **Mod-Enter** always splits (escape from list).
 * - **Mod-a** is a two-step escalation: first press selects all text in the
 *   current block; second press selects the whole document.
 *
 * Backspace, ArrowUp/Down, joinBackward, etc. are all handled by ProseMirror's
 * defaults — they Just Work in a single-doc model.
 */
export const KeyboardActions = Extension.create({
  name: "mochiKeyboardActions",

  addKeyboardShortcuts() {
    const splitMochiBlock = () =>
      splitMochiBlockAtSelection(this.editor, this.editor.state);

    return {
      // Enter inside a paragraph or heading directly under a mochiBlock:
      // split the textblock (depth 1) so the new sibling is a paragraph
      // INSIDE the same mochiBlock — never escalates to a new mochiBlock.
      // Cmd+Enter is the only "make a new mochiBlock" gesture.
      Enter: () => {
        if (suggestionOpen(this.editor)) return false;
        const { state, view } = this.editor;
        const { $from } = state.selection;
        const parent = $from.parent.type.name;
        // Defer to defaults for lists, code blocks, tables, blockquote.
        if (parent !== "paragraph" && parent !== "heading") return false;
        const grandparent = $from.node($from.depth - 1);
        if (!grandparent || grandparent.type.name !== "mochiBlock") return false;

        const paraType = state.schema.nodes.paragraph;
        if (!paraType) return false;

        let tr = state.tr;
        if (!state.selection.empty) tr = tr.deleteSelection();
        // Always splits into a paragraph as the new sibling — even from a
        // heading — so Enter at the end of a heading produces body text.
        tr = tr.split(tr.selection.$from.pos, 1, [{ type: paraType }]);
        view.dispatch(tr.scrollIntoView());
        return true;
      },

      "Mod-Enter": () => {
        if (suggestionOpen(this.editor)) return false;
        return splitMochiBlock();
      },

      "Mod-a": () => {
        const { state } = this.editor;
        const { $from } = state.selection;
        const tbStart = $from.start($from.depth);
        const tbEnd = $from.end($from.depth);
        const allInTextblock =
          state.selection.from <= tbStart && state.selection.to >= tbEnd;

        if (!allInTextblock) {
          // First press: select all text in the current paragraph / heading.
          const sel = TextSelection.create(state.doc, tbStart, tbEnd);
          this.editor.view.dispatch(state.tr.setSelection(sel));
          return true;
        }
        // Second press: select the whole document.
        this.editor.commands.selectAll();
        return true;
      },
    };
  },
});

/** True when a `@tiptap/suggestion` plugin (slash, hashtag) is currently open. */
function suggestionOpen(editor: any): boolean {
  const state = editor.state;
  for (const p of state.plugins) {
    const s = p.getState?.(state);
    if (s && typeof s === "object" && (s as any).active) return true;
  }
  return false;
}

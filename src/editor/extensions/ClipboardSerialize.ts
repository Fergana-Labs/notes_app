import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

const key = new PluginKey("mochiClipboardSerialize");

const NBSP = " ";

/**
 * Serialize a selection slice to clean markdown with NO blank line
 * between rows. Each top-level node becomes one chunk; chunks join with a
 * single newline so a few short paragraphs / list items don't land
 * double-spaced when pasted into another app.
 */
function sliceToMarkdown(editor: any, slice: Slice): string {
  const serializer = editor.storage?.markdown?.serializer;
  if (!serializer) {
    return slice.content.textBetween(0, slice.content.size, "\n");
  }
  const parts: string[] = [];
  slice.content.forEach((node: any) => {
    try {
      if (node.type.name === "mochiBlock") {
        const chunks: string[] = [];
        node.content.forEach((child: any) => {
          const md: string = serializer.serialize(child).replace(/\s+$/, "");
          if (md) chunks.push(md);
        });
        if (chunks.length > 0) parts.push(chunks.join("\n"));
      } else {
        const md: string = serializer.serialize(node).replace(/\s+$/, "");
        if (md) parts.push(md);
      }
    } catch {
      const fallback = node.textContent;
      if (fallback) parts.push(fallback);
    }
  });
  return parts.join("\n");
}

/**
 * Clipboard behavior for the note editors.
 *
 * Copy / cut: write our tight markdown to `text/plain` AND suppress
 * `text/html`. ProseMirror's default also puts an HTML blob on the
 * clipboard (one `<p>` per block), and apps like Obsidian / Apple Notes
 * prefer that HTML — converting each `<p>` back to a blank-line-separated
 * paragraph, which is exactly the double-spacing users complained about.
 * Omitting `text/html` makes those apps fall back to our clean markdown.
 *
 * Paste: when pasted text contains blank lines, convert each blank line
 * into a visible empty paragraph (NBSP) before parsing, so intentional
 * spacing copied from Obsidian survives instead of collapsing into a mere
 * paragraph break. Text without blank lines falls through to the default
 * (tiptap-markdown) paste so structure / formatting still parse.
 */
export const ClipboardSerialize = Extension.create({
  name: "mochiClipboardSerialize",

  addProseMirrorPlugins() {
    const editor = this.editor;

    const writeClipboard = (view: EditorView, event: ClipboardEvent, isCut: boolean) => {
      const { state } = view;
      if (state.selection.empty || !event.clipboardData) return false;
      const md = sliceToMarkdown(editor, state.selection.content());
      event.preventDefault();
      event.clipboardData.setData("text/plain", md);
      // Intentionally NO text/html — see the doc comment above.
      if (isCut) {
        view.dispatch(state.tr.deleteSelection().scrollIntoView());
      }
      return true;
    };

    return [
      new Plugin({
        key,
        props: {
          // text/plain serialization for callers that read it directly.
          clipboardTextSerializer: (slice: Slice) => sliceToMarkdown(editor, slice),
          // Preserve blank lines copied from other markdown apps: turn each
          // blank line into an NBSP paragraph BEFORE the (tiptap-markdown)
          // clipboard parser runs, so they survive as visible empty rows
          // instead of collapsing into a bare paragraph break. We only
          // transform the text — parsing into real nodes stays with the
          // proven markdown paste pipeline (manually inserting parsed HTML
          // was landing markup as literal text).
          transformPastedText: (text: string) => {
            if (!/\n[ \t]*\n/.test(text)) return text;
            return text.replace(/(\n[ \t]*){2,}/g, (m) => {
              const newlines = (m.match(/\n/g) || []).length;
              const blanks = Math.max(0, newlines - 1);
              return "\n\n" + `${NBSP}\n\n`.repeat(blanks);
            });
          },
          handleDOMEvents: {
            copy: (view, event) => writeClipboard(view, event as ClipboardEvent, false),
            cut: (view, event) => writeClipboard(view, event as ClipboardEvent, true),
          },
        },
      }),
    ];
  },
});

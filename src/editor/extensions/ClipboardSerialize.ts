import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

const key = new PluginKey("mochiClipboardSerialize");

const NBSP = " ";

/**
 * Serialize a selection slice to markdown that preserves the document's
 * structure: each block-level node (paragraph, list, heading, …) becomes one
 * chunk, and chunks join with a BLANK line so adjacent paragraphs stay
 * distinct rather than merging. Empty paragraphs and empty list items are kept
 * (as empty chunks) so intentional blank lines and empty bullets survive a
 * copy → paste round trip — both between notes in the app and into external
 * editors. (The earlier version stripped trailing whitespace, dropped empty
 * chunks, and joined with a single newline, which silently lost blank lines
 * and empty bullets and ran paragraphs together.)
 */
export function sliceToMarkdown(editor: any, slice: Slice): string {
  const serializer = editor.storage?.markdown?.serializer;
  if (!serializer) {
    return slice.content.textBetween(0, slice.content.size, "\n");
  }
  const blocks: string[] = [];
  const pushNode = (node: any) => {
    let md: string;
    try {
      md = serializer.serialize(node);
    } catch {
      md = node.textContent ?? "";
    }
    // Drop only the serializer's trailing newlines, not the content — keep
    // empty results so blank paragraphs / empty bullets aren't lost.
    blocks.push(md.replace(/\n+$/, ""));
  };
  slice.content.forEach((node: any) => {
    if (node.type.name === "mochiBlock") {
      // Canvas block: its children are the block-level content.
      node.content.forEach(pushNode);
    } else {
      pushNode(node);
    }
  });
  return blocks.join("\n\n");
}

/**
 * The slice + text/plain payload we last wrote on copy/cut, tagged with the
 * originating editor. On paste, if the clipboard's text/plain still matches
 * this verbatim AND it came from the same editor, we reuse the slice directly
 * instead of round-tripping through markdown — so pasting back into the same
 * note preserves bullets, list nesting, and empty lines exactly. This mirrors
 * ProseMirror's own internal copy/paste dedupe (it compares the serialized
 * clipboard against a cached slice); we key on text/plain because we suppress
 * text/html. Any external paste — or a paste into a different editor instance,
 * whose schema may differ — misses the cache and falls through to the proven
 * markdown paste pipeline below.
 */
let lastCopied: { editor: unknown; text: string; slice: Slice } | null = null;
const normalizeEol = (s: string) => s.replace(/\r\n/g, "\n");

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
      const slice = state.selection.content();
      const md = sliceToMarkdown(editor, slice);
      event.preventDefault();
      event.clipboardData.setData("text/plain", md);
      // Intentionally NO text/html — see the doc comment above.
      // Remember the exact slice so a paste back into this same editor can
      // reuse it verbatim instead of re-parsing the tight markdown (which
      // merges adjacent paragraphs and drops empty lines).
      lastCopied = { editor, text: normalizeEol(md), slice };
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
          // Paste back into the same editor: if the clipboard still holds
          // exactly what we copied from here, replace the selection with the
          // cached slice so structure (bullets, nesting, blank lines) survives
          // intact. Otherwise return false to let the markdown paste run.
          handlePaste: (view, event) => {
            const cd = (event as ClipboardEvent).clipboardData;
            if (!cd || !lastCopied || lastCopied.editor !== editor) return false;
            const incoming = normalizeEol(cd.getData("text/plain"));
            if (!incoming || incoming !== lastCopied.text) return false;
            const { state } = view;
            view.dispatch(state.tr.replaceSelection(lastCopied.slice).scrollIntoView());
            event.preventDefault();
            return true;
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

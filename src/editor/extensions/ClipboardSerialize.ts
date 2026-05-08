import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";

const key = new PluginKey("mochiClipboardSerialize");

/**
 * When the user copies content out of the canvas, emit clean markdown
 * (without `<!-- block:ID -->` markers and without an extra blank line per
 * block).
 *
 * Default ProseMirror text serialization treats every block boundary as
 * `\n\n`. On our schema — where each visible block is a `mochiBlock` wrapper
 * containing one or more inner block-level nodes (paragraph / heading /
 * list / ...) — that produces *two* sets of separators between paragraphs
 * (one for the wrapper, one for the inner block), which shows up as a blank
 * line everywhere when you paste into another app.
 *
 * We replace it with the tiptap-markdown serializer, applied per-child
 * inside each mochiBlock and then joined with a single blank line.
 */
export const ClipboardSerialize = Extension.create({
  name: "mochiClipboardSerialize",

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key,
        props: {
          clipboardTextSerializer: (slice: Slice) => {
            const serializer = (editor.storage as any).markdown?.serializer;
            if (!serializer) {
              return slice.content.textBetween(0, slice.content.size, "\n\n");
            }
            const parts: string[] = [];
            slice.content.forEach((node) => {
              try {
                if (node.type.name === "mochiBlock") {
                  // Render each inner child individually; one trailing blank
                  // line per child, then trimmed and rejoined.
                  const chunks: string[] = [];
                  node.content.forEach((child) => {
                    const md: string = serializer
                      .serialize(child)
                      .replace(/\s+$/, "");
                    if (md) chunks.push(md);
                  });
                  if (chunks.length > 0) parts.push(chunks.join("\n\n"));
                } else {
                  const md: string = serializer
                    .serialize(node)
                    .replace(/\s+$/, "");
                  if (md) parts.push(md);
                }
              } catch {
                const fallback = node.textContent;
                if (fallback) parts.push(fallback);
              }
            });
            return parts.join("\n\n");
          },
        },
      }),
    ];
  },
});

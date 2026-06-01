import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Slice } from "@tiptap/pm/model";

const key = new PluginKey("mochiClipboardSerialize");

/**
 * When the user copies content out of a card, emit clean markdown — no
 * `<!-- block:ID -->` markers, and crucially NO blank line between rows.
 *
 * Default ProseMirror text serialization treats every block boundary as
 * `\n\n`, so copying a few short paragraphs or list items into another
 * app (Obsidian, Notes, …) lands a blank line between every row. Users
 * read each block as a "row" and want them tight, so we serialize each
 * top-level node to markdown and join with a single newline.
 *
 * (On the legacy single-doc canvas each visible block was a `mochiBlock`
 * wrapper; we still unwrap those for safety, joining their inner children
 * with a single newline too.)
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
              return slice.content.textBetween(0, slice.content.size, "\n");
            }
            const parts: string[] = [];
            slice.content.forEach((node) => {
              try {
                if (node.type.name === "mochiBlock") {
                  const chunks: string[] = [];
                  node.content.forEach((child) => {
                    const md: string = serializer
                      .serialize(child)
                      .replace(/\s+$/, "");
                    if (md) chunks.push(md);
                  });
                  if (chunks.length > 0) parts.push(chunks.join("\n"));
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
            // Single newline between rows — no blank-line padding.
            return parts.join("\n");
          },
        },
      }),
    ];
  },
});

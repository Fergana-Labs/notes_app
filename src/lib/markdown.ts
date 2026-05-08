import MarkdownIt from "markdown-it";
// @ts-expect-error — no shipped types for markdown-it-task-lists
import taskLists from "markdown-it-task-lists";
import type { Editor } from "@tiptap/core";
import { DOMParser as PMDOMParser } from "@tiptap/pm/model";
import type { BlockInput, StoredBlock } from "./ipc";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
}).use(taskLists, { enabled: true, label: false });

/**
 * Build an HTML string suitable for `editor.commands.setContent()` from the
 * Rust-parsed block list. Each parsed block becomes a single
 * `<div data-block-id=…>…</div>` shell — the schema's `block+` content rule
 * lets a mochiBlock hold multiple paragraphs / headings / lists if the
 * source markdown had them.
 */
export function htmlFromBlocks(blocks: StoredBlock[]): string {
  return blocks
    .map((b) => {
      const inner = md.render(b.content || "");
      const tagsAttr =
        b.tags.length > 0
          ? ` data-tags='${escapeAttr(JSON.stringify(b.tags))}'`
          : "";
      const manualAttr = b.manual_tags ? ` data-manual-tags="true"` : "";
      // Empty blocks need at least one paragraph so PM has somewhere to put
      // the cursor.
      const safeInner = inner.trim() ? inner : "<p></p>";
      return `<div data-block-id="${b.id}"${tagsAttr}${manualAttr}>${safeInner}</div>`;
    })
    .join("");
}

/**
 * Convert the parsed-block list to a ProseMirror JSON document, ready to feed
 * to `editor.commands.setContent(json)`.
 *
 * We bypass the markdown route deliberately — tiptap-markdown's `setContent`
 * override pipes any string input through markdown-it (which would escape our
 * HTML wrappers into text). Passing JSON skips that override and lets PM use
 * its DOMParser directly against the schema.
 */
export function jsonFromBlocks(editor: Editor, blocks: StoredBlock[]) {
  const html = htmlFromBlocks(blocks);
  const container = document.createElement("div");
  container.innerHTML = html || "<div data-block-id=\"\"><p></p></div>";
  const docNode = PMDOMParser.fromSchema(editor.schema).parse(container);
  return docNode.toJSON();
}

/**
 * Serialize the entire editor doc to canvas markdown using tiptap-markdown's
 * built-in serializer + the custom `mochiBlock.markdown.serialize` hook
 * (defined in extensions/Block.ts) which prepends each block with its ID
 * comment.
 *
 * Used only by the "Export markdown" command — the live save path uses
 * `snapshotBlocks` to write per-block rows directly to SQLite.
 */
export function docToMarkdown(editor: Editor): string {
  const serializer = (editor.storage as any).markdown?.serializer;
  if (!serializer) return "";
  const out: string = serializer.serialize(editor.state.doc);
  return out.endsWith("\n") ? out : out + "\n";
}

const BLOCK_MARKER = /<!-- block:([0-9A-HJKMNP-TV-Z]{26}) -->\n/g;

/**
 * Tiptap-markdown's serializer escapes `#` at the start of a line as `\#`
 * so it isn't mistaken for a heading. That's the right call for actual
 * leading `# ` (heading marker) text, but it also escapes inline-style
 * hashtags like `#yo` typed at the start of a paragraph. The Rust-side
 * hashtag regex requires whitespace or start-of-line before `#`, and `\`
 * is neither — so without this pass, brand-new tags entered at the start
 * of a block would never make it into the `tags` index.
 *
 * We unescape only when followed by a tag-name letter (no space), which
 * leaves real escaped `# ` heading-prefixes alone.
 */
export function unescapeInlineHashtags(md: string): string {
  return md.replace(/(^|\n)\\#(?=[A-Za-z])/g, "$1#");
}

/**
 * Snapshot the editor's current block list as `BlockInput`s ready to send to
 * `ipc.saveBlocks`. Each item carries its serialized markdown content,
 * structural position, and heading/parent_id metadata derived from the
 * heading-depth stack.
 *
 * Implementation: serialize the whole doc once via the tiptap-markdown
 * serializer (which emits `<!-- block:ID -->\n<inner>\n\n` per block), split
 * on the ID markers, and zip with the structural walk.
 */
export function snapshotBlocks(editor: Editor): BlockInput[] {
  const serializer = (editor.storage as any).markdown?.serializer;
  if (!serializer) return [];
  const fullMd: string = serializer.serialize(editor.state.doc);
  const contentById = splitMarkdownByMarkers(fullMd);

  const out: BlockInput[] = [];
  const stack: { level: number; id: string }[] = [];
  let pos = 0;

  editor.state.doc.forEach((node: any) => {
    if (node.type.name !== "mochiBlock" || !node.attrs.id) return;
    const id: string = node.attrs.id;
    const content = contentById.get(id) ?? "";

    let heading: string | null = null;
    let heading_level: number | null = null;
    const first = node.firstChild;
    if (first && first.type.name === "heading") {
      heading_level = first.attrs.level ?? null;
      heading = first.textContent || null;
    }

    let parent_id: string | null = null;
    if (heading_level != null) {
      while (stack.length && stack[stack.length - 1].level >= heading_level) {
        stack.pop();
      }
      parent_id = stack.length ? stack[stack.length - 1].id : null;
      stack.push({ level: heading_level, id });
    } else {
      parent_id = stack.length ? stack[stack.length - 1].id : null;
    }

    out.push({ id, content, position: pos, parent_id, heading, heading_level });
    pos++;
  });

  return out;
}

function splitMarkdownByMarkers(md: string): Map<string, string> {
  const map = new Map<string, string>();
  const matches: { id: string; start: number; markerEnd: number }[] = [];
  BLOCK_MARKER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_MARKER.exec(md)) !== null) {
    matches.push({ id: m[1], start: m.index, markerEnd: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].markerEnd;
    const end = i + 1 < matches.length ? matches[i + 1].start : md.length;
    const raw = md.substring(start, end).replace(/\s+$/, "");
    map.set(matches[i].id, unescapeInlineHashtags(raw));
  }
  return map;
}

function escapeAttr(s: string): string {
  return s.replace(/'/g, "&apos;");
}

/**
 * Heading nesting tree for the sections sidebar pane. Built from the
 * Rust-derived block list (which carries heading_level + parent_id).
 */
export interface SectionNode {
  id: string;
  heading: string;
  level: number;
  children: SectionNode[];
}

/**
 * IDs of all blocks transitively descended from `rootId` via parent_id (which
 * the Rust parser sets based on heading-depth nesting). Used by the sidebar
 * drag-reorder to move a heading along with its owned subtree.
 */
export function descendantIds(blocks: StoredBlock[], rootId: string): string[] {
  const childrenById = new Map<string, string[]>();
  for (const b of blocks) {
    if (b.parent_id) {
      const arr = childrenById.get(b.parent_id) ?? [];
      arr.push(b.id);
      childrenById.set(b.parent_id, arr);
    }
  }
  const out: string[] = [];
  const walk = (id: string) => {
    for (const child of childrenById.get(id) ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(rootId);
  return out;
}

export function buildSectionTree(blocks: StoredBlock[]): SectionNode[] {
  const headings = blocks.filter((b) => b.heading_level != null);
  const roots: SectionNode[] = [];
  const stack: SectionNode[] = [];
  for (const h of headings) {
    const node: SectionNode = {
      id: h.id,
      heading: h.heading ?? "",
      level: h.heading_level!,
      children: [],
    };
    while (stack.length && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

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

const TAG_RE = /(?:^|\s)#([A-Za-z][A-Za-z0-9_\-/]*)/g;
const URL_RE = /https?:\/\/\S+/g;

/**
 * Extract inline `#hashtags` from a block's markdown content. Mirrors the
 * Rust-side `parser::extract_hashtags` so the frontend can update the tags
 * column locally after a save without an IPC round-trip.
 */
export function extractInlineTags(content: string): string[] {
  const tags: string[] = [];
  let inCode = false;
  for (const line of content.split("\n")) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const stripped = line.replace(URL_RE, "");
    TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_RE.exec(stripped)) !== null) {
      const t = m[1].toLowerCase();
      if (!tags.includes(t)) tags.push(t);
    }
  }
  return tags;
}

/**
 * Snapshot the editor's current block list as `BlockInput`s ready to send to
 * `ipc.saveBlocks`.
 *
 * Per-node markdown is **cached by ProseMirror node reference**. PM nodes are
 * immutable, so for any block the user hasn't touched since the last save,
 * the cached markdown is reused — meaning a save tick on a 2k-block doc
 * goes from a full-doc serialize (100-200 ms) to one node serialized
 * (<1 ms) plus a cheap iteration. The reload effect in CanvasEditor still
 * works because cache entries for replaced nodes get GC'd via WeakMap.
 */
const nodeContentCache = new WeakMap<object, string>();
const BLOCK_MARKER_PREFIX = /^<!-- block:[0-9A-HJKMNP-TV-Z]{26} -->\n/;

function markdownFromMochiBlock(editor: Editor, node: any): string | null {
  const serializer = (editor.storage as any).markdown?.serializer;
  if (!serializer) return null;

  let content = nodeContentCache.get(node);
  if (content === undefined) {
    // Serialize just this block. mochiBlock's storage.markdown.serialize
    // hook (Block.ts) writes `<!-- block:ID -->\n<inner>\n\n` — strip
    // the marker and trailing newlines, then unescape any `\#tag` that
    // tiptap-markdown's `esc()` produced.
    const md: string = serializer.serialize(node);
    content = unescapeInlineHashtags(
      md.replace(BLOCK_MARKER_PREFIX, "").replace(/\s+$/, ""),
    );
    nodeContentCache.set(node, content);
  }
  return content;
}

function headingFromMochiBlock(node: any) {
  let heading: string | null = null;
  let heading_level: number | null = null;
  const first = node.firstChild;
  if (first && first.type.name === "heading") {
    heading_level = first.attrs.level ?? null;
    heading = first.textContent || null;
  }
  return { heading, heading_level };
}

export function snapshotBlocks(editor: Editor): BlockInput[] {
  if (!(editor.storage as any).markdown?.serializer) return [];

  const out: BlockInput[] = [];
  const stack: { level: number; id: string }[] = [];
  let pos = 0;

  editor.state.doc.forEach((node: any) => {
    if (node.type.name !== "mochiBlock" || !node.attrs.id) return;
    const id: string = node.attrs.id;

    const content = markdownFromMochiBlock(editor, node);
    if (content == null) return;
    const { heading, heading_level } = headingFromMochiBlock(node);

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

/**
 * Snapshot one existing top-level mochiBlock. Used by the live canvas save
 * path for ordinary typing, where parent nesting is unchanged and a full
 * document walk would make large documents feel sticky.
 */
export function snapshotBlockById(
  editor: Editor,
  id: string,
  parent_id: string | null,
): BlockInput | null {
  if (!(editor.storage as any).markdown?.serializer) return null;

  let result: BlockInput | null = null;
  let position = 0;
  editor.state.doc.forEach((node: any) => {
    if (result) return;
    if (node.type.name !== "mochiBlock" || !node.attrs.id) {
      position++;
      return;
    }
    if (node.attrs.id !== id) {
      position++;
      return;
    }

    const content = markdownFromMochiBlock(editor, node);
    if (content == null) return;
    const { heading, heading_level } = headingFromMochiBlock(node);
    result = { id, content, position, parent_id, heading, heading_level };
  });
  return result;
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

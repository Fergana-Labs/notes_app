import Document from "@tiptap/extension-document";

/**
 * Override the standard Document so that the only allowed top-level children
 * are `mochiBlock` nodes. Any markdown that gets pasted at top level is
 * normalized into mochiBlocks via the doc loader; in-editor splits/joins also
 * always produce mochiBlocks because of the schema.
 */
export const MochiDocument = Document.extend({
  content: "mochiBlock+",
});

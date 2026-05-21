import { Extension } from "@tiptap/core";

export interface HashtagOptions {
  /** Kept for backwards compatibility with existing call sites. */
  getTags: () => string[];
}

/**
 * Tag recognition lives at save-time (workspace.saveSnapshot extracts
 * inline `#tag` patterns via `extractInlineTags`), so this extension
 * doesn't actually need to do anything in the editor. The old version
 * used `@tiptap/suggestion` + `tippy.js` to show an autocomplete picker
 * when the user typed `#`, but that popup kept flashing in unwanted
 * places (mount-time when the cursor landed inside an existing
 * `#tag`, frame-after-commit even with synchronous destroy). The
 * chip-strip `TagAdder` already provides explicit tag-add UX with
 * its own dropdown, so the inline picker was redundant.
 *
 * Kept as a no-op extension to avoid changing every call site that
 * still passes `Hashtag.configure({ getTags })`.
 */
export const Hashtag = Extension.create<HashtagOptions>({
  name: "hashtag",
  addOptions() {
    return { getTags: () => [] };
  },
});

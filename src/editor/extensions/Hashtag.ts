import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import tippy, { type Instance } from "tippy.js";
import { HashtagList, type HashtagListItem, type HashtagListHandle } from "../HashtagList";

const hashtagPluginKey = new PluginKey("mochiHashtag");

export interface HashtagOptions {
  getTags: () => string[];
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const Hashtag = Extension.create<HashtagOptions>({
  name: "hashtag",

  addOptions() {
    return { getTags: () => [] };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<HashtagListItem>({
        editor: this.editor,
        pluginKey: hashtagPluginKey,
        char: "#",
        startOfLine: false,
        allowSpaces: false,
        items: ({ query }: { query: string }) => {
          const all = options.getTags();
          const lower = query.toLowerCase();
          const matched: HashtagListItem[] = all
            .filter((t) => t.toLowerCase().includes(lower))
            .sort((a, b) => {
              const ai = a.toLowerCase().startsWith(lower) ? 0 : 1;
              const bi = b.toLowerCase().startsWith(lower) ? 0 : 1;
              return ai - bi || a.localeCompare(b);
            })
            .slice(0, 8)
            .map((t) => ({ tag: t }));
          const cleaned = sanitize(query);
          if (cleaned && !matched.some((m) => m.tag === cleaned)) {
            matched.push({ tag: cleaned, isNew: true });
          }
          return matched;
        },
        command: ({ editor, range, props }) => {
          editor
            .chain()
            .focus()
            .insertContentAt(
              { from: range.from, to: range.to },
              `#${props.tag} `,
            )
            .run();
        },
        render: () => {
          let component: ReactRenderer<HashtagListHandle> | null = null;
          let popup: Instance[] | null = null;

          return {
            onStart: (props: SuggestionProps<HashtagListItem>) => {
              component = new ReactRenderer(HashtagList, {
                props,
                editor: props.editor,
              });
              if (!props.clientRect) return;
              popup = tippy("body", {
                getReferenceClientRect: () => {
                  const r = props.clientRect?.();
                  return r ?? new DOMRect();
                },
                appendTo: () => document.body,
                content: component.element,
                showOnCreate: true,
                interactive: true,
                trigger: "manual",
                placement: "bottom-start",
                offset: [0, 4],
                arrow: false,
                theme: "light-border",
              });
            },
            onUpdate: (props: SuggestionProps<HashtagListItem>) => {
              component?.updateProps(props);
              if (popup && props.clientRect) {
                popup[0]?.setProps({
                  getReferenceClientRect: () => {
                    const r = props.clientRect?.();
                    return r ?? new DOMRect();
                  },
                });
              }
            },
            onKeyDown: (props) => {
              if (props.event.key === "Escape") {
                popup?.[0]?.hide();
                return true;
              }
              return component?.ref?.onKeyDown(props as any) ?? false;
            },
            onExit: () => {
              popup?.[0]?.destroy();
              popup = null;
              component?.destroy();
              component = null;
            },
          };
        },
      }),
    ];
  },
});

import { Extension } from "@tiptap/core";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionProps } from "@tiptap/suggestion";
import { ReactRenderer } from "@tiptap/react";
import tippy, { type Instance } from "tippy.js";
import {
  SlashMenuList,
  type SlashMenuItem,
  type SlashMenuListHandle,
} from "../SlashMenuList";
import { buildSlashItems, filterSlashItems } from "../blockTypes";

const slashPluginKey = new PluginKey("mochiSlash");

/**
 * `/` triggers an inline block-type / insertion menu (Heading, list, code, etc.).
 */
export const SlashMenu = Extension.create({
  name: "slashMenu",

  addProseMirrorPlugins() {
    return [
      Suggestion<SlashMenuItem>({
        editor: this.editor,
        pluginKey: slashPluginKey,
        char: "/",
        startOfLine: false,
        allowSpaces: false,
        items: ({ query, editor }) =>
          filterSlashItems(buildSlashItems(editor), query),
        command: ({ editor: ed, range, props }) => {
          props.run({ range });
          // refocus after mutation
          ed.chain().focus().run();
        },
        render: () => {
          let component: ReactRenderer<SlashMenuListHandle> | null = null;
          let popup: Instance[] | null = null;

          return {
            onStart: (props: SuggestionProps<SlashMenuItem>) => {
              component = new ReactRenderer(SlashMenuList, {
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
            onUpdate: (props: SuggestionProps<SlashMenuItem>) => {
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

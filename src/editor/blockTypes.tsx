import {
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Code2,
  Quote,
  Minus,
  Type,
  type LucideIcon,
} from "lucide-react";
import type { Editor } from "@tiptap/core";
import type { SlashMenuItem } from "./SlashMenuList";

interface BlockTypeDef {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  keywords: string[];
  isActive: (editor: Editor) => boolean;
  apply: (editor: Editor, range?: { from: number; to: number }) => void;
}

/**
 * Block-type definitions used by both the slash menu and the bubble-menu's
 * "Turn into" dropdown.
 */
export const BLOCK_TYPES: BlockTypeDef[] = [
  {
    id: "paragraph",
    label: "Text",
    description: "Plain paragraph.",
    icon: Type,
    keywords: ["text", "p", "paragraph", "plain"],
    isActive: (e) => e.isActive("paragraph"),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.setNode("paragraph").run();
    },
  },
  {
    id: "h1",
    label: "Heading 1",
    description: "Big section heading.",
    icon: Heading1,
    keywords: ["h1", "heading", "title"],
    isActive: (e) => e.isActive("heading", { level: 1 }),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.toggleHeading({ level: 1 }).run();
    },
  },
  {
    id: "h2",
    label: "Heading 2",
    description: "Medium section heading.",
    icon: Heading2,
    keywords: ["h2", "heading", "subheading"],
    isActive: (e) => e.isActive("heading", { level: 2 }),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.toggleHeading({ level: 2 }).run();
    },
  },
  {
    id: "h3",
    label: "Heading 3",
    description: "Small section heading.",
    icon: Heading3,
    keywords: ["h3", "heading"],
    isActive: (e) => e.isActive("heading", { level: 3 }),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.toggleHeading({ level: 3 }).run();
    },
  },
  {
    id: "bullet",
    label: "Bullet list",
    description: "A simple unordered list.",
    icon: List,
    keywords: ["bullet", "list", "ul", "unordered"],
    isActive: (e) => e.isActive("bulletList"),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.toggleBulletList().run();
    },
  },
  {
    id: "numbered",
    label: "Numbered list",
    description: "An ordered list.",
    icon: ListOrdered,
    keywords: ["number", "ol", "ordered", "list"],
    isActive: (e) => e.isActive("orderedList"),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.toggleOrderedList().run();
    },
  },
  {
    id: "todo",
    label: "To-do list",
    description: "Checkbox list with toggleable items.",
    icon: ListChecks,
    keywords: ["todo", "task", "checkbox", "check"],
    isActive: (e) => e.isActive("taskList"),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      // toggleTaskList from @tiptap/extension-task-list
      (chain as any).toggleTaskList().run();
    },
  },
  {
    id: "code",
    label: "Code",
    description: "Multi-line code block.",
    icon: Code2,
    keywords: ["code", "snippet", "monospace"],
    isActive: (e) => e.isActive("codeBlock"),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.toggleCodeBlock().run();
    },
  },
  {
    id: "quote",
    label: "Quote",
    description: "Stylized quote.",
    icon: Quote,
    keywords: ["quote", "blockquote"],
    isActive: (e) => e.isActive("blockquote"),
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.toggleBlockquote().run();
    },
  },
  {
    id: "divider",
    label: "Divider",
    description: "Horizontal rule.",
    icon: Minus,
    keywords: ["divider", "hr", "rule", "separator"],
    isActive: () => false,
    apply: (e, range) => {
      const chain = e.chain().focus();
      if (range) chain.deleteRange(range);
      chain.setHorizontalRule().run();
    },
  },
];

export function buildSlashItems(editor: Editor): SlashMenuItem[] {
  return BLOCK_TYPES.map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description,
    icon: <b.icon size={14} />,
    keywords: b.keywords,
    run: ({ range }) => b.apply(editor, range),
  }));
}

export function filterSlashItems(items: SlashMenuItem[], query: string): SlashMenuItem[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((it) => {
    if (it.label.toLowerCase().includes(q)) return true;
    if (it.id.toLowerCase().includes(q)) return true;
    return it.keywords.some((k) => k.toLowerCase().includes(q));
  });
}

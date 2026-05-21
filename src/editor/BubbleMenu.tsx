import { useEditorState } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import type { Editor } from "@tiptap/core";
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Code,
  Link as LinkIcon,
  ChevronDown,
  Type as TypeIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { BLOCK_TYPES } from "./blockTypes";

interface Props {
  editor: Editor | null;
}

// Stable refs for `BubbleMenu`'s `options` and `shouldShow` props. Tiptap's
// React `BubbleMenu` lists both in a useEffect deps array — if either has a
// new identity per render, the effect re-fires and dispatches a PM
// transaction (`type: "updateOptions"`) to the bubble-menu plugin. On a
// 2k-block canvas, every transaction walks every NodeView, so a re-render
// of CanvasEditor (which happens on every debounced save while typing)
// turns into 2k extra NodeView updates per save tick. Hoisting these out
// of the component body keeps their identity stable.
const BUBBLE_OPTIONS = { placement: "top" as const, offset: 8 };
const EMPTY_MENU_STATE = {
  visible: false,
  blockTypeId: "paragraph",
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: false,
  href: "",
};

type MenuState = typeof EMPTY_MENU_STATE;

function menuStateEq(a: MenuState, b: MenuState | null): boolean {
  return (
    !!b &&
    a.visible === b.visible &&
    a.blockTypeId === b.blockTypeId &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.link === b.link &&
    a.href === b.href
  );
}

const shouldShowBubble = ({
  editor: e,
  state,
}: {
  editor: Editor;
  state: any;
}): boolean => {
  const { selection } = state;
  if (selection.empty) return false;
  // Hide while a suggestion popup is open (slash / hashtag).
  for (const p of state.plugins) {
    const s = p.getState?.(state);
    if (s && typeof s === "object" && (s as any).active) return false;
  }
  // Hide inside code blocks (formatting buttons would no-op).
  if (e.isActive("codeBlock")) return false;
  return true;
};

export function BlockBubbleMenu({ editor }: Props) {
  const [showTurnInto, setShowTurnInto] = useState(false);
  const [showLinkInput, setShowLinkInput] = useState(false);
  const menuState =
    useEditorState({
      editor,
      selector: ({ editor: e }) => {
        if (!e || e.state.selection.empty) return EMPTY_MENU_STATE;
        const linkAttrs = e.getAttributes("link") as any;
        return {
          visible: true,
          blockTypeId: BLOCK_TYPES.find((b) => b.isActive(e))?.id ?? "paragraph",
          bold: e.isActive("bold"),
          italic: e.isActive("italic"),
          underline: e.isActive("underline"),
          strike: e.isActive("strike"),
          code: e.isActive("code"),
          link: e.isActive("link"),
          href: linkAttrs.href ?? "",
        };
      },
      equalityFn: menuStateEq,
    }) ?? EMPTY_MENU_STATE;

  if (!editor) return null;

  return (
    <BubbleMenu
      editor={editor}
      options={BUBBLE_OPTIONS}
      shouldShow={shouldShowBubble}
      className="z-30"
    >
      <div className="flex items-center gap-0.5 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg p-0.5">
        <TurnIntoButton
          editor={editor}
          activeTypeId={menuState.blockTypeId}
          open={showTurnInto}
          onOpenChange={setShowTurnInto}
        />
        <Sep />
        <ToolbarBtn
          active={menuState.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
          title="Bold (⌘B)"
        >
          <Bold size={14} />
        </ToolbarBtn>
        <ToolbarBtn
          active={menuState.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          title="Italic (⌘I)"
        >
          <Italic size={14} />
        </ToolbarBtn>
        <ToolbarBtn
          active={menuState.underline}
          onClick={() => (editor.chain().focus() as any).toggleUnderline().run()}
          title="Underline (⌘U)"
        >
          <Underline size={14} />
        </ToolbarBtn>
        <ToolbarBtn
          active={menuState.strike}
          onClick={() => editor.chain().focus().toggleStrike().run()}
          title="Strikethrough"
        >
          <Strikethrough size={14} />
        </ToolbarBtn>
        <ToolbarBtn
          active={menuState.code}
          onClick={() => editor.chain().focus().toggleCode().run()}
          title="Inline code (⌘E)"
        >
          <Code size={14} />
        </ToolbarBtn>
        <Sep />
        <LinkButton
          editor={editor}
          active={menuState.link}
          href={menuState.href}
          open={showLinkInput}
          onOpenChange={setShowLinkInput}
        />
      </div>
    </BubbleMenu>
  );
}

function ToolbarBtn({
  children,
  active,
  onClick,
  title,
}: {
  children: React.ReactNode;
  active?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Prevent stealing focus from the editor (would collapse selection).
        e.preventDefault();
        onClick();
      }}
      title={title}
      className={`p-1.5 rounded ${
        active
          ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
          : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
      }`}
    >
      {children}
    </button>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />;
}

function TurnIntoButton({
  editor,
  activeTypeId,
  open,
  onOpenChange,
}: {
  editor: Editor;
  activeTypeId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const current = BLOCK_TYPES.find((b) => b.id === activeTypeId) ?? BLOCK_TYPES[0];
  // Portal anchor — the dropdown is rendered into document.body with
  // viewport-fixed coords so it escapes the bubble menu's positioning
  // context (which can clip it behind cards below).
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setAnchorRect(null);
      return;
    }
    const measure = () => {
      const el = ref.current?.querySelector("button");
      if (!el) return;
      setAnchorRect(el.getBoundingClientRect());
    };
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (dropdownRef.current?.contains(t)) return;
      onOpenChange(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open, onOpenChange]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          onOpenChange(!open);
        }}
        className="flex items-center gap-1 px-1.5 py-1.5 rounded text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 text-xs font-medium"
        title="Change block type"
      >
        <TypeIcon size={14} />
        <span className="hidden sm:inline">{current.label}</span>
        <ChevronDown size={11} />
      </button>
      {open && anchorRect &&
        createPortal(
          <div
            ref={dropdownRef}
            style={{
              position: "fixed",
              top: anchorRect.bottom + 4,
              left: Math.min(
                anchorRect.left,
                window.innerWidth - 200,
              ),
              zIndex: 70,
            }}
            className="w-48 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1"
          >
            {BLOCK_TYPES.map((b) => {
              const active = b.id === activeTypeId;
              return (
                <button
                  key={b.id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    b.apply(editor);
                    onOpenChange(false);
                  }}
                  className={`w-full flex items-center gap-2 px-2 py-1 text-left text-sm ${
                    active
                      ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                      : "hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-200"
                  }`}
                >
                  <b.icon size={14} className="shrink-0" />
                  <span className="truncate">{b.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}

function LinkButton({
  editor,
  active,
  href,
  open,
  onOpenChange,
}: {
  editor: Editor;
  active: boolean;
  href: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (open) {
      setValue(href);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open, href]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [open, onOpenChange]);

  const apply = () => {
    const href = value.trim();
    if (!href) {
      editor.chain().focus().unsetLink().run();
    } else {
      const url = /^[a-z]+:\/\//i.test(href) ? href : `https://${href}`;
      editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    }
    onOpenChange(false);
  };

  return (
    <div ref={ref} className="relative">
      <ToolbarBtn
        active={active}
        onClick={() => onOpenChange(!open)}
        title="Link (⌘K)"
      >
        <LinkIcon size={14} />
      </ToolbarBtn>
      {open && (
        <div
          className="absolute top-full right-0 mt-1 flex items-center gap-1 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg p-1 z-50"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="https://"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                apply();
              } else if (e.key === "Escape") {
                onOpenChange(false);
              }
            }}
            className="px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 w-56 font-mono"
          />
          <button
            type="button"
            onMouseDown={(e) => {
              e.preventDefault();
              apply();
            }}
            className="px-2 py-1 text-xs rounded bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Save
          </button>
          {active && (
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                editor.chain().focus().unsetLink().run();
                onOpenChange(false);
              }}
              className="px-2 py-1 text-xs rounded text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              Remove
            </button>
          )}
        </div>
      )}
    </div>
  );
}

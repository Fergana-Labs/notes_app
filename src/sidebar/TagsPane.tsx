import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS as DndCSS } from "@dnd-kit/utilities";
import { ChevronDown, ChevronRight, FolderPlus, Plus } from "lucide-react";
import { useWorkspace } from "../stores/workspace";
import { ipc, type TagCount } from "../lib/ipc";
import { TagContextMenu } from "./TagContextMenu";
import { TagDescriptionModal } from "./TagDescriptionModal";
import { TagDeleteModal } from "./TagDeleteModal";

interface Props {
  selected: string | null;
  onOpenTag: (tag: string) => void;
  onClearTag: () => void;
}

// Sidebar items are encoded as plain strings. A folder is prefixed with
// "folder:"; a tag is the bare tag name. They share a single
// SortableContext at root level so folders can be drag-reordered into
// any position among root tags.
type SidebarEntry =
  | { kind: "tag"; name: string }
  | { kind: "folder"; name: string };

const FOLDER_PREFIX = "folder:";

function encode(e: SidebarEntry): string {
  return e.kind === "folder" ? `${FOLDER_PREFIX}${e.name}` : e.name;
}

function decode(id: string): SidebarEntry {
  if (id.startsWith(FOLDER_PREFIX)) {
    return { kind: "folder", name: id.slice(FOLDER_PREFIX.length) };
  }
  return { kind: "tag", name: id };
}

/**
 * Sidebar tag list. Root level holds tags AND folders in user-defined
 * order (drag a folder to slot it anywhere among the tags). Folder
 * children are tags whose `folder` metadata points at that folder;
 * they render indented under the folder header and can be reordered
 * among each other in a nested sortable context. Right-click any
 * tag for description / delete actions; right-click a folder for
 * rename / delete.
 */
export function TagsPane({ selected, onOpenTag, onClearTag }: Props) {
  const tags = useWorkspace((s) => s.tags);
  const refreshTags = useWorkspace((s) => s.refreshTags);
  const reload = useWorkspace((s) => s.reload);

  const [contextMenu, setContextMenu] = useState<{
    tag: TagCount;
    x: number;
    y: number;
  } | null>(null);
  const [descriptionTag, setDescriptionTag] = useState<TagCount | null>(null);
  const [deleteTag, setDeleteTag] = useState<TagCount | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [newFolderDraft, setNewFolderDraft] = useState<string | null>(null);
  const [newTagDraft, setNewTagDraft] = useState<string | null>(null);
  const [folderContextMenu, setFolderContextMenu] = useState<{
    name: string;
    x: number;
    y: number;
  } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  // Drop-indicator state — which item the dragged thing will land
  // before/after. Updated in onDragOver.
  const [dropTarget, setDropTarget] = useState<{
    id: string;
    position: "before" | "after";
  } | null>(null);

  // The canonical root-level order: a list of encoded sidebar entries
  // (tag names or "folder:Name"). Persisted in the `sidebar_order`
  // setting. This is the source of truth for "which folders exist"
  // and where folders sit relative to root tags. Tags INSIDE folders
  // are NOT in this list — they're determined by their `folder` field.
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => {
    const dedupe = (arr: string[]): string[] => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const id of arr) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    };
    void ipc.getSetting("sidebar_order").then((raw) => {
      if (raw) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            const clean = dedupe(arr);
            setOrder(clean);
            // Heal a previously-broken setting in one shot.
            if (clean.length !== arr.length) {
              void ipc.setSetting("sidebar_order", JSON.stringify(clean));
            }
            return;
          }
        } catch {
          /* fall through to bootstrap */
        }
      }
      // No saved order — bootstrap from legacy tag_folder_order.
      // The auto-add effect below will fill in root tags as it
      // observes them in the workspace store.
      void ipc.getSetting("tag_folder_order").then((legacyRaw) => {
        let legacyFolders: string[] = [];
        if (legacyRaw) {
          try {
            const arr = JSON.parse(legacyRaw);
            if (Array.isArray(arr)) legacyFolders = arr;
          } catch {
            /* ignore */
          }
        }
        setOrder(dedupe(legacyFolders.map((f) => `${FOLDER_PREFIX}${f}`)));
      });
    });
  }, []);

  const persistOrder = async (next: string[]) => {
    // Dedupe before persisting — any single buggy drag path that
    // mistakenly splices a duplicate gets sanitized once and never
    // shows up in subsequent renders. Preserves first-occurrence
    // order, which is what the user sees.
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const id of next) {
      if (id == null || id === "") continue;
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(id);
    }
    setOrder(deduped);
    await ipc.setSetting("sidebar_order", JSON.stringify(deduped));
  };

  // Auto-add any root-level tags (no folder) that aren't in `order` yet.
  // Also auto-add any folder a tag references but isn't in `order`.
  // Runs whenever tags or order changes.
  useEffect(() => {
    if (order === null) return;
    const have = new Set(order);
    const additions: string[] = [];
    for (const t of tags) {
      if (t.folder) {
        const fid = `${FOLDER_PREFIX}${t.folder}`;
        if (!have.has(fid)) {
          additions.push(fid);
          have.add(fid);
        }
      } else {
        if (!have.has(t.tag)) {
          additions.push(t.tag);
          have.add(t.tag);
        }
      }
    }
    if (additions.length > 0) {
      void persistOrder([...order, ...additions]);
    }
  }, [tags, order]);

  // Live-derived view: only entries that still correspond to a real
  // tag (with no folder) or a folder marker. Filters out dead entries
  // for tags that were moved into folders or deleted entirely.
  const visible = useMemo(() => {
    if (order === null) return [] as SidebarEntry[];
    const tagSet = new Map(tags.map((t) => [t.tag, t]));
    const out: SidebarEntry[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const e = decode(id);
      if (e.kind === "folder") {
        out.push(e);
      } else {
        const t = tagSet.get(e.name);
        if (t && !t.folder) out.push(e);
      }
    }
    return out;
  }, [order, tags]);

  // Child tags grouped by folder for nested rendering.
  const childrenByFolder = useMemo(() => {
    const m = new Map<string, TagCount[]>();
    for (const t of tags) {
      if (!t.folder) continue;
      const arr = m.get(t.folder) ?? [];
      arr.push(t);
      m.set(t.folder, arr);
    }
    return m;
  }, [tags]);

  const onDragOver = (e: DragOverEvent) => {
    if (!e.over || e.active.id === e.over.id) {
      setDropTarget(null);
      return;
    }
    if (order === null) {
      setDropTarget(null);
      return;
    }
    const activeId = String(e.active.id);
    const overId = String(e.over.id);
    if (overId === "__root__") {
      setDropTarget(null);
      return;
    }
    const activeIdx = order.indexOf(activeId);
    const overIdx = order.indexOf(overId);
    if (overIdx < 0) {
      // Drop target isn't in the root order (it's a folder child).
      // For simplicity, indicate "before" the inside-tag — its visual
      // sibling parent.
      setDropTarget({ id: overId, position: "before" });
      return;
    }
    setDropTarget({
      id: overId,
      position: activeIdx >= 0 && activeIdx < overIdx ? "after" : "before",
    });
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setDropTarget(null);
    if (order === null) return;
    const { active, over } = e;
    if (!over) return;
    const draggedId = String(active.id);
    const overId = String(over.id);
    if (draggedId === overId) return;

    const dragged = decode(draggedId);
    const draggedTag =
      dragged.kind === "tag" ? tags.find((t) => t.tag === dragged.name) : null;
    const draggedInFolder = draggedTag?.folder ?? null;

    // CASE: drop on a folder header → put the dragged item INTO that
    // folder (if dragged is a tag), OR reorder folders if dragged is
    // a folder.
    if (overId.startsWith(FOLDER_PREFIX)) {
      const overFolder = decode(overId).name;
      if (dragged.kind === "tag") {
        // Move tag into folder. Remove from root order if present.
        await ipc.setTagFolder(dragged.name, overFolder);
        if (order.includes(draggedId)) {
          await persistOrder(order.filter((x) => x !== draggedId));
        }
        await refreshTags();
        return;
      }
      // Dragged folder onto another folder header → reorder.
      if (dragged.name === overFolder) return;
      const without = order.filter((x) => x !== draggedId);
      const targetIdx = without.indexOf(overId);
      if (targetIdx < 0) return;
      await persistOrder([
        ...without.slice(0, targetIdx),
        draggedId,
        ...without.slice(targetIdx),
      ]);
      return;
    }

    // CASE: drop on the root drop zone (clears folder if dragging an
    // inside-folder tag back to root; adds it to the END of root order).
    if (overId === "__root__") {
      if (dragged.kind === "tag" && draggedInFolder) {
        await ipc.setTagFolder(dragged.name, null);
        await persistOrder([...order, dragged.name]);
        await refreshTags();
      }
      return;
    }

    // CASE: drop on a tag.
    const over_ = decode(overId);
    if (over_.kind !== "tag") return;
    const overTag = tags.find((t) => t.tag === over_.name);
    if (!overTag) return;

    // 1) Both dragged + over are inside the SAME folder → reorder
    //    among siblings inside that folder via reorderTags.
    if (
      dragged.kind === "tag" &&
      draggedInFolder &&
      overTag.folder === draggedInFolder
    ) {
      const folder = draggedInFolder;
      const siblings = (childrenByFolder.get(folder) ?? []).map((t) => t.tag);
      const from = siblings.indexOf(dragged.name);
      const to = siblings.indexOf(over_.name);
      if (from < 0 || to < 0) return;
      const next = [...siblings];
      next.splice(from, 1);
      next.splice(to, 0, dragged.name);
      const others = tags
        .filter((t) => t.folder !== folder)
        .map((t) => t.tag);
      await ipc.reorderTags([...others, ...next]);
      await refreshTags();
      return;
    }

    // 2) Dragged inside-folder tag dropped on a different-folder
    //    inside tag → move into that folder.
    if (dragged.kind === "tag" && draggedInFolder && overTag.folder) {
      await ipc.setTagFolder(dragged.name, overTag.folder);
      await refreshTags();
      return;
    }

    // 3) Dragged inside-folder tag dropped on a root tag → move to
    //    root at over position. Filter draggedId out first so we
    //    never end up with a duplicate even if order somehow already
    //    contained the tag.
    if (dragged.kind === "tag" && draggedInFolder && !overTag.folder) {
      await ipc.setTagFolder(dragged.name, null);
      const without = order.filter((x) => x !== dragged.name);
      const overIdx = without.indexOf(overId);
      const next =
        overIdx >= 0
          ? [...without.slice(0, overIdx), dragged.name, ...without.slice(overIdx)]
          : [...without, dragged.name];
      await persistOrder(next);
      await refreshTags();
      return;
    }

    // 4) Dragged root tag dropped on another root tag → reorder root.
    // 5) Dragged folder dropped on a root tag → reorder root (place
    //    folder at over's position).
    // 6) Dragged root tag dropped on a tag INSIDE a folder → move
    //    into that folder.
    if (dragged.kind === "tag" && !draggedInFolder && overTag.folder) {
      await ipc.setTagFolder(dragged.name, overTag.folder);
      if (order.includes(draggedId)) {
        await persistOrder(order.filter((x) => x !== draggedId));
      }
      await refreshTags();
      return;
    }
    // Cases 4 + 5: drop on a root tag, reorder root list.
    if (!order.includes(draggedId)) {
      // dragged isn't currently in root order (shouldn't happen for
      // root tags / folders, but defend).
      return;
    }
    const without = order.filter((x) => x !== draggedId);
    const targetIdx = without.indexOf(overId);
    if (targetIdx < 0) return;
    await persistOrder([
      ...without.slice(0, targetIdx),
      draggedId,
      ...without.slice(targetIdx),
    ]);
  };

  const toggleFolder = (name: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Create an empty tag from the sidebar. Goes through setTagDescription
  // with an empty description string — that upserts the `tags` row, which
  // makes it count = 0 in `list_tags` and appear in the sidebar. The
  // user can then drag blocks into the tag or assign it from a card.
  const commitNewTag = async (name: string) => {
    const t = name.trim().toLowerCase().replace(/^#/, "");
    if (!t) {
      setNewTagDraft(null);
      return;
    }
    if (!/^[A-Za-z][A-Za-z0-9_\-/]*$/.test(t)) {
      window.alert(
        `Invalid tag name: "${t}". Tags must start with a letter and use only letters, digits, underscore, dash, or slash.`,
      );
      return;
    }
    await ipc.setTagDescription(t, "");
    await refreshTags();
    setNewTagDraft(null);
  };

  const commitNewFolder = async (name: string) => {
    const n = name.trim();
    if (!n) {
      setNewFolderDraft(null);
      return;
    }
    const id = `${FOLDER_PREFIX}${n}`;
    if (order && !order.includes(id)) {
      await persistOrder([...order, id]);
    }
    setNewFolderDraft(null);
  };

  const renameFolder = async (oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName || !order) return;
    const tagsInFolder = tags.filter((t) => t.folder === oldName);
    await Promise.all(
      tagsInFolder.map((t) => ipc.setTagFolder(t.tag, n)),
    );
    await persistOrder(
      order.map((id) => (id === `${FOLDER_PREFIX}${oldName}` ? `${FOLDER_PREFIX}${n}` : id)),
    );
    await refreshTags();
  };

  const removeFolder = async (name: string) => {
    if (!order) return;
    const tagsInFolder = tags.filter((t) => t.folder === name);
    await Promise.all(
      tagsInFolder.map((t) => ipc.setTagFolder(t.tag, null)),
    );
    // Append freed-up tags to root order; drop the folder marker.
    const freed = tagsInFolder.map((t) => t.tag);
    await persistOrder([
      ...order.filter((id) => id !== `${FOLDER_PREFIX}${name}`),
      ...freed,
    ]);
    await refreshTags();
  };

  const rootItems = visible.map((e) => encode(e));

  return (
    <div className="p-2 space-y-0.5">
      <div className="flex items-center gap-2 mb-1">
        <button
          onClick={onClearTag}
          className={`flex-1 flex justify-between text-sm px-2 py-1 rounded ${
            selected == null
              ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
              : "hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
          }`}
        >
          <span>All blocks</span>
        </button>
        <button
          onClick={() => setNewTagDraft("")}
          title="New tag"
          className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <Plus size={14} />
        </button>
        <button
          onClick={() => setNewFolderDraft("")}
          title="New folder"
          className="p-1 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          <FolderPlus size={14} />
        </button>
      </div>

      {newTagDraft !== null && (
        <div className="flex items-center gap-1 px-2 py-1 text-sm rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950">
          <span className="text-neutral-400">#</span>
          <input
            autoFocus
            value={newTagDraft}
            onChange={(e) => setNewTagDraft(e.target.value.replace(/^#/, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void commitNewTag(newTagDraft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                setNewTagDraft(null);
              }
            }}
            onBlur={() => void commitNewTag(newTagDraft)}
            placeholder="tag-name"
            className="flex-1 outline-none bg-transparent"
          />
        </div>
      )}

      {newFolderDraft !== null && (
        <input
          autoFocus
          value={newFolderDraft}
          onChange={(e) => setNewFolderDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitNewFolder(newFolderDraft);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setNewFolderDraft(null);
            }
          }}
          onBlur={() => commitNewFolder(newFolderDraft)}
          placeholder="Folder name…"
          className="w-full px-2 py-1 text-sm rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none"
        />
      )}

      {tags.length === 0 && (order?.length ?? 0) === 0 && (
        <p className="px-2 py-1 text-xs text-neutral-500 italic">
          No tags yet. Use <code>#foo</code> inline in any block.
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDropTarget(null)}
      >
        <RootDropZone>
          <SortableContext
            items={rootItems}
            strategy={verticalListSortingStrategy}
          >
            {visible.map((e) => {
              const indicator =
                dropTarget?.id === encode(e) ? dropTarget.position : null;
              if (e.kind === "tag") {
                const t = tags.find((x) => x.tag === e.name);
                if (!t) return null;
                return (
                  <TagRow
                    key={`tag:${e.name}`}
                    tag={t}
                    active={selected === t.tag}
                    dropIndicator={indicator}
                    onOpen={() => onOpenTag(t.tag)}
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      setContextMenu({ tag: t, x: ev.clientX, y: ev.clientY });
                    }}
                  />
                );
              }
              // Folder
              const folder = e.name;
              const collapsed = collapsedFolders.has(folder);
              const children = childrenByFolder.get(folder) ?? [];
              return (
                <FolderSection
                  key={`folder:${folder}`}
                  folder={folder}
                  collapsed={collapsed}
                  count={children.length}
                  dropIndicator={indicator}
                  onToggle={() => toggleFolder(folder)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setFolderContextMenu({
                      name: folder,
                      x: ev.clientX,
                      y: ev.clientY,
                    });
                  }}
                >
                  {!collapsed && (
                    <SortableContext
                      items={children.map((t) => t.tag)}
                      strategy={verticalListSortingStrategy}
                    >
                      {children.length === 0 ? (
                        <p className="px-3 py-1 text-[11px] text-neutral-400 italic">
                          Drag tags here
                        </p>
                      ) : (
                        children.map((t) => (
                          <TagRow
                            key={t.tag}
                            tag={t}
                            active={selected === t.tag}
                            indent
                            onOpen={() => onOpenTag(t.tag)}
                            onContextMenu={(ev) => {
                              ev.preventDefault();
                              setContextMenu({
                                tag: t,
                                x: ev.clientX,
                                y: ev.clientY,
                              });
                            }}
                          />
                        ))
                      )}
                    </SortableContext>
                  )}
                </FolderSection>
              );
            })}
          </SortableContext>
        </RootDropZone>
      </DndContext>

      {contextMenu &&
        createPortal(
          <TagContextMenu
            tag={contextMenu.tag}
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            onEditDescription={() => {
              setDescriptionTag(contextMenu.tag);
              setContextMenu(null);
            }}
            onDelete={() => {
              setDeleteTag(contextMenu.tag);
              setContextMenu(null);
            }}
          />,
          document.body,
        )}

      {folderContextMenu &&
        createPortal(
          <FolderContextMenu
            name={folderContextMenu.name}
            x={folderContextMenu.x}
            y={folderContextMenu.y}
            onClose={() => setFolderContextMenu(null)}
            onRename={(newName) => {
              void renameFolder(folderContextMenu.name, newName);
              setFolderContextMenu(null);
            }}
            onDelete={() => {
              void removeFolder(folderContextMenu.name);
              setFolderContextMenu(null);
            }}
          />,
          document.body,
        )}

      {descriptionTag && (
        <TagDescriptionModal
          tag={descriptionTag}
          onClose={() => setDescriptionTag(null)}
          onSaved={async () => {
            await refreshTags();
            setDescriptionTag(null);
          }}
        />
      )}

      {deleteTag && (
        <TagDeleteModal
          tag={deleteTag}
          onClose={() => setDeleteTag(null)}
          onConfirmed={async () => {
            await reload();
            setDeleteTag(null);
          }}
        />
      )}
    </div>
  );
}

function RootDropZone({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: "__root__" });
  return (
    <div
      ref={setNodeRef}
      className={`rounded ${isOver ? "bg-blue-50 dark:bg-blue-900/20" : ""}`}
    >
      {children}
    </div>
  );
}

function FolderSection({
  folder,
  collapsed,
  count,
  dropIndicator,
  onToggle,
  onContextMenu,
  children,
}: {
  folder: string;
  collapsed: boolean;
  count: number;
  dropIndicator: "before" | "after" | null;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: `${FOLDER_PREFIX}${folder}` });

  const style: React.CSSProperties = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="mt-1 group/folder relative">
      {dropIndicator && (
        <div
          aria-hidden
          className={`absolute inset-x-1 ${
            dropIndicator === "before" ? "-top-0.5" : "-bottom-0.5"
          } h-0.5 bg-blue-500 rounded-full pointer-events-none`}
        />
      )}
      <div
        {...attributes}
        {...listeners}
        onContextMenu={onContextMenu}
        title="Drag to reorder · drop tags here to organize"
        className={`flex items-center gap-1 px-1.5 py-1 rounded text-xs text-neutral-500 dark:text-neutral-400 font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-grab active:cursor-grabbing ${
          isOver ? "bg-blue-50 dark:bg-blue-900/20" : ""
        }`}
      >
        {/* No stopPropagation on pointerdown — PointerSensor's
            `distance: 4` activation already separates clicks from
            drags. Without this, drags initiated on the chevron/name
            area (the bulk of the row) didn't propagate to the drag
            listeners and the user could only drag from the right
            edge where the count sat. */}
        <button
          onClick={onToggle}
          className="flex items-center gap-1 flex-1 text-left"
        >
          {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
          <span className="truncate">{folder}</span>
        </button>
        <span className="text-[10px] text-neutral-400">{count}</span>
      </div>
      {children}
    </div>
  );
}

function TagRow({
  tag,
  active,
  indent,
  dropIndicator,
  onOpen,
  onContextMenu,
}: {
  tag: TagCount;
  active: boolean;
  indent?: boolean;
  dropIndicator?: "before" | "after" | null;
  onOpen: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: tag.tag });

  const style: React.CSSProperties = {
    transform: DndCSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`group/tag relative flex items-center ${indent ? "pl-3" : ""} cursor-grab active:cursor-grabbing`}
      onContextMenu={onContextMenu}
      title="Drag to reorder · drop on a folder to organize"
    >
      {dropIndicator && (
        <div
          aria-hidden
          className={`absolute inset-x-1 ${
            dropIndicator === "before" ? "-top-0.5" : "-bottom-0.5"
          } h-0.5 bg-blue-500 rounded-full pointer-events-none`}
        />
      )}
      <button
        onClick={onOpen}
        title={tag.description || undefined}
        className={`w-full flex justify-between text-sm px-2 py-1 rounded ${
          active
            ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
            : "hover:bg-neutral-100 dark:hover:bg-neutral-800"
        }`}
      >
        <span className="truncate text-left">#{tag.tag}</span>
        <span className="text-neutral-400 shrink-0 ml-2">{tag.count}</span>
      </button>
    </div>
  );
}

function FolderContextMenu({
  name,
  x,
  y,
  onClose,
  onRename,
  onDelete,
}: {
  name: string;
  x: number;
  y: number;
  onClose: () => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);

  useEffect(() => {
    if (renaming) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest?.(".__folder-ctx")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose, renaming]);

  return (
    <div
      className="__folder-ctx fixed z-50 w-52 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg py-1 text-sm"
      style={{ top: y, left: x }}
    >
      <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-400">
        Folder: {name}
      </div>
      {renaming ? (
        <div className="px-2 py-1">
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onRename(draft);
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            className="w-full px-2 py-1 text-sm rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 outline-none"
          />
        </div>
      ) : (
        <button
          onClick={() => setRenaming(true)}
          className="w-full px-3 py-1.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
        >
          Rename folder…
        </button>
      )}
      <button
        onClick={onDelete}
        className="w-full px-3 py-1.5 text-left text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
      >
        Delete folder (keeps tags)
      </button>
    </div>
  );
}

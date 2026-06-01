import { create } from "zustand";
import { ipc } from "../lib/ipc";

/**
 * Feed view mode:
 *  - `card`  — full card: header bar (title, tags, actions) + body.
 *  - `note`  — body text only, no header chrome (reads like a doc).
 *  - `list`  — one compact row per note: title (or first line) + first
 *              body line.
 */
export type ViewMode = "card" | "note" | "list";

/**
 * UI-appearance settings — distinct from chatSettings (capture-bar
 * preferences) because these touch the whole app shell.
 */
interface UISettings {
  colorful: boolean;
  /** Compact mode trims card padding and inter-card spacing so more
   *  blocks fit on screen at once. Activated via a `.compact` class
   *  on <html>; CSS rules in index.css override the comfy defaults. */
  compact: boolean;
  /** Active feed view mode. `note` hides the per-card header (the old
   *  `hideHeaders` flag); `list` is the old titles-only row view. */
  viewMode: ViewMode;
  /** Sidebar tag scope: `priority` shows only flagged tags, `all` shows
   *  everything. */
  tagScope: "priority" | "all";
  loaded: boolean;
  load: () => Promise<void>;
  setColorful: (v: boolean) => Promise<void>;
  setCompact: (v: boolean) => Promise<void>;
  setViewMode: (v: ViewMode) => Promise<void>;
  setTagScope: (v: "priority" | "all") => Promise<void>;
}

export const useUISettings = create<UISettings>((set) => ({
  colorful: false,
  compact: false,
  viewMode: "card",
  tagScope: "all",
  loaded: false,
  load: async () => {
    const [c, cm, vm, hh, ts] = await Promise.all([
      ipc.getSetting("ui.colorful"),
      ipc.getSetting("ui.compact"),
      ipc.getSetting("ui.view_mode"),
      ipc.getSetting("ui.hide_headers"),
      ipc.getSetting("ui.tag_scope"),
    ]);
    // Prefer the new view_mode key; fall back to the legacy hide_headers
    // boolean (true → note view) for workspaces saved before the merge.
    let viewMode: ViewMode = "card";
    if (vm === "card" || vm === "note" || vm === "list") viewMode = vm;
    else if (hh === "true") viewMode = "note";
    set({
      colorful: c === "true",
      compact: cm === "true",
      viewMode,
      tagScope: ts === "priority" ? "priority" : "all",
      loaded: true,
    });
  },
  setColorful: async (v) => {
    await ipc.setSetting("ui.colorful", v ? "true" : "false");
    set({ colorful: v });
  },
  setCompact: async (v) => {
    await ipc.setSetting("ui.compact", v ? "true" : "false");
    set({ compact: v });
  },
  setViewMode: async (v) => {
    await ipc.setSetting("ui.view_mode", v);
    set({ viewMode: v });
  },
  setTagScope: async (v) => {
    await ipc.setSetting("ui.tag_scope", v);
    set({ tagScope: v });
  },
}));

import { create } from "zustand";
import { ipc } from "../lib/ipc";

/**
 * UI-appearance settings — distinct from chatSettings (capture-bar
 * preferences) because these touch the whole app shell. Currently
 * one flag: `colorful`, which switches the sidebar tint and the
 * chat send button from neutral/blue to the icon's warm/teal vibe.
 */
interface UISettings {
  colorful: boolean;
  /** Compact mode trims card padding and inter-card spacing so more
   *  blocks fit on screen at once. Activated via a `.compact` class
   *  on <html>; CSS rules in index.css override the comfy defaults. */
  compact: boolean;
  /** Hide each block card's top header (avatar/tag chips/buttons row)
   *  so the feed reads like a tight todo list. Toggled from the feed
   *  toolbar; persisted alongside the other view preferences. */
  hideHeaders: boolean;
  loaded: boolean;
  load: () => Promise<void>;
  setColorful: (v: boolean) => Promise<void>;
  setCompact: (v: boolean) => Promise<void>;
  setHideHeaders: (v: boolean) => Promise<void>;
}

export const useUISettings = create<UISettings>((set) => ({
  colorful: false,
  compact: false,
  hideHeaders: false,
  loaded: false,
  load: async () => {
    const [c, cm, hh] = await Promise.all([
      ipc.getSetting("ui.colorful"),
      ipc.getSetting("ui.compact"),
      ipc.getSetting("ui.hide_headers"),
    ]);
    set({
      colorful: c === "true",
      compact: cm === "true",
      hideHeaders: hh === "true",
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
  setHideHeaders: async (v) => {
    await ipc.setSetting("ui.hide_headers", v ? "true" : "false");
    set({ hideHeaders: v });
  },
}));

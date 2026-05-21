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
  loaded: boolean;
  load: () => Promise<void>;
  setColorful: (v: boolean) => Promise<void>;
}

export const useUISettings = create<UISettings>((set) => ({
  colorful: false,
  loaded: false,
  load: async () => {
    const v = await ipc.getSetting("ui.colorful");
    set({ colorful: v === "true", loaded: true });
  },
  setColorful: async (v) => {
    await ipc.setSetting("ui.colorful", v ? "true" : "false");
    set({ colorful: v });
  },
}));

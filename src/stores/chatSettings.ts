import { create } from "zustand";
import { ipc } from "../lib/ipc";

export type Direction = "top" | "bottom";

interface ChatSettings {
  direction: Direction;
  loaded: boolean;
  load: () => Promise<void>;
  setDirection: (d: Direction) => Promise<void>;
}

export const useChatSettings = create<ChatSettings>((set) => ({
  direction: "top",
  loaded: false,
  load: async () => {
    const v = await ipc.getSetting("chat.direction");
    if (v === "top" || v === "bottom") set({ direction: v });
    set({ loaded: true });
  },
  setDirection: async (d) => {
    await ipc.setSetting("chat.direction", d);
    set({ direction: d });
  },
}));

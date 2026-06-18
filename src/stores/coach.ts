import { create } from "zustand";
import {
  coachConfig,
  listConversations,
  createConversation,
  type CoachConfig,
  type CoachConversation,
} from "../coach/coachApi";

/**
 * Shared coach conversation state: the sidebar list and the main chat view both
 * read it, so selecting/creating a conversation in one updates the other.
 * `config` (relay url + token) comes from sync status; null means unpaired.
 */
interface CoachState {
  config: CoachConfig | null;
  conversations: CoachConversation[];
  activeId: string | null;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setActive: (id: string) => void;
  newConversation: () => Promise<void>;
}

export const useCoach = create<CoachState>((set, get) => ({
  config: null,
  conversations: [],
  activeId: null,
  loaded: false,
  error: null,

  load: async () => {
    try {
      const config = await coachConfig();
      if (!config) {
        set({ config: null, conversations: [], activeId: null, loaded: true, error: null });
        return;
      }
      const conversations = await listConversations(config);
      set((s) => ({
        config,
        conversations,
        // Keep the current selection if still present; else pick the newest.
        activeId:
          s.activeId && conversations.some((c) => c.id === s.activeId)
            ? s.activeId
            : (conversations[0]?.id ?? null),
        loaded: true,
        error: null,
      }));
    } catch (e) {
      set({ error: String(e), loaded: true });
    }
  },

  refresh: async () => {
    const { config } = get();
    if (!config) return;
    try {
      const conversations = await listConversations(config);
      set({ conversations });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setActive: (id) => set({ activeId: id }),

  newConversation: async () => {
    const { config } = get();
    if (!config) return;
    try {
      const convo = await createConversation(config, "");
      set((s) => ({ conversations: [convo, ...s.conversations], activeId: convo.id }));
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

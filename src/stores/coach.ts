import { create } from "zustand";
import { ipc, type CoachConversationRow } from "../lib/ipc";
import { coachConfig, listConversations, createConversation, type CoachConfig } from "../coach/coachApi";

/**
 * Shared coach state. Conversations + messages live in the synced op log; the
 * desktop reads them from its LOCAL replica (Tauri commands) so history is
 * available offline and consistent with notes. The relay is still the agent
 * host: we hit it to author a default conversation / create new ones / stream
 * replies, then pull the authored ops into the local DB.
 */
interface CoachState {
  config: CoachConfig | null;
  conversations: CoachConversationRow[];
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
      // Bootstrap: hitting the relay ensures a default conversation has been
      // authored; the sync tick pulls it (and any peer activity) into the local
      // replica. Best-effort — offline falls back to whatever's already local.
      try {
        await listConversations(config);
        await ipc.syncTick();
      } catch {
        /* offline / relay waking — use the local replica */
      }
      const conversations = await ipc.coachListConversations();
      set((s) => ({
        config,
        conversations,
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
    try {
      set({ conversations: await ipc.coachListConversations() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setActive: (id) => set({ activeId: id }),

  newConversation: async () => {
    const { config } = get();
    if (!config) return;
    try {
      const convo = await createConversation(config, ""); // relay authors the op
      await ipc.syncTick().catch(() => {});
      const local = await ipc.coachListConversations();
      // Show it immediately even if the sync pull hasn't landed yet.
      const conversations = local.some((c) => c.id === convo.id)
        ? local
        : [{ ...convo }, ...local];
      set({ conversations, activeId: convo.id });
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));

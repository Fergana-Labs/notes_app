import { create } from "zustand";
import { ipc, type CoachConversationRow } from "../lib/ipc";
import {
  coachConfig,
  listConversations,
  createConversation,
  deleteConversation as apiDeleteConversation,
  updateConversation as apiUpdateConversation,
  setDefaultSystemPrompt as apiSetDefaultSystemPrompt,
  type CoachConfig,
} from "../coach/coachApi";

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
  /** Workspace default persona (system-prompt note) for new conversations. */
  defaultSystemPromptNoteId: string | null;
  /** Text to seed the coach input with (set by "send a note to the coach").
   *  CoachView consumes it once and clears it. */
  pendingInput: string | null;
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  setActive: (id: string) => void;
  newConversation: () => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
  setPersona: (id: string, noteId: string | null) => Promise<void>;
  setDefaultPersona: (noteId: string | null) => Promise<void>;
  /** Seed the coach input (used when sending a note into the coach). */
  seedInput: (text: string) => void;
  consumePendingInput: () => string | null;
}

export const useCoach = create<CoachState>((set, get) => ({
  config: null,
  conversations: [],
  activeId: null,
  defaultSystemPromptNoteId: null,
  pendingInput: null,
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
      let defaultSystemPromptNoteId = get().defaultSystemPromptNoteId;
      try {
        const remote = await listConversations(config);
        defaultSystemPromptNoteId = remote.defaultSystemPromptNoteId;
        await ipc.syncTick();
      } catch {
        /* offline / relay waking — use the local replica */
      }
      const conversations = await ipc.coachListConversations();
      set((s) => ({
        config,
        conversations,
        defaultSystemPromptNoteId,
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
        : [{ ...convo, system_prompt_note_id: convo.system_prompt_note_id ?? null }, ...local];
      set({ conversations, activeId: convo.id });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeConversation: async (id) => {
    const { config } = get();
    if (!config) return;
    try {
      await apiDeleteConversation(config, id);
      await ipc.syncTick().catch(() => {});
      const conversations = await ipc.coachListConversations();
      set((s) => ({
        conversations,
        // Keep the active selection valid if the deleted one was active.
        activeId:
          s.activeId === id || !conversations.some((c) => c.id === s.activeId)
            ? (conversations[0]?.id ?? null)
            : s.activeId,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setPersona: async (id, noteId) => {
    const { config } = get();
    if (!config) return;
    try {
      await apiUpdateConversation(config, id, { systemPromptNoteId: noteId });
      await ipc.syncTick().catch(() => {});
      // Optimistic update so the UI reflects the change before sync lands.
      set((s) => ({
        conversations: s.conversations.map((c) =>
          c.id === id ? { ...c, system_prompt_note_id: noteId } : c,
        ),
      }));
      set({ conversations: await ipc.coachListConversations() });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  setDefaultPersona: async (noteId) => {
    const { config } = get();
    if (!config) return;
    try {
      await apiSetDefaultSystemPrompt(config, noteId);
      set({ defaultSystemPromptNoteId: noteId });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  seedInput: (text) => set({ pendingInput: text }),

  consumePendingInput: () => {
    const text = get().pendingInput;
    if (text !== null) set({ pendingInput: null });
    return text;
  },
}));

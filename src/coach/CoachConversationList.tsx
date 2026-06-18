import { useEffect, useMemo, useState } from "react";
import { Plus, MessageSquare, Trash2, UserCog } from "lucide-react";
import { useCoach } from "../stores/coach";
import { useWorkspace } from "../stores/workspace";
import { NotePicker } from "./NotePicker";

/** First non-empty line / title of a block, for showing a persona name. */
function personaName(blocks: { id: string; title: string | null; content: string }[], id: string | null): string | null {
  if (!id) return null;
  const b = blocks.find((x) => x.id === id);
  if (!b) return "note";
  const title = (b.title ?? "").trim();
  if (title) return title;
  const first = b.content.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.trim().slice(0, 40) || "note";
}

/**
 * Sidebar list of coach conversations (shown when the Coach tab is active).
 * Selecting one drives the main-panel chat via the shared coach store. Each row
 * carries a persona picker (note → system prompt) and a delete affordance; a
 * footer control sets the workspace default persona for new conversations.
 */
export function CoachConversationList() {
  const config = useCoach((s) => s.config);
  const conversations = useCoach((s) => s.conversations);
  const activeId = useCoach((s) => s.activeId);
  const defaultPersona = useCoach((s) => s.defaultSystemPromptNoteId);
  const loaded = useCoach((s) => s.loaded);
  const error = useCoach((s) => s.error);
  const load = useCoach((s) => s.load);
  const setActive = useCoach((s) => s.setActive);
  const newConversation = useCoach((s) => s.newConversation);
  const removeConversation = useCoach((s) => s.removeConversation);
  const setPersona = useCoach((s) => s.setPersona);
  const setDefaultPersona = useCoach((s) => s.setDefaultPersona);
  const blocks = useWorkspace((s) => s.blocks);

  // Which conversation's persona picker is open (id), or "__default__" for the
  // workspace default control, or null when none is open.
  const [picking, setPicking] = useState<string | null>(null);

  // Refresh the list whenever the tab is shown.
  useEffect(() => {
    void load();
  }, [load]);

  const defaultName = useMemo(() => personaName(blocks, defaultPersona), [blocks, defaultPersona]);

  if (loaded && !config) {
    return (
      <p className="px-3 py-4 text-xs text-neutral-500">
        Pair with a relay (Settings → Sync) to use the coach.
      </p>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        onClick={() => void newConversation()}
        className="flex items-center gap-2 mx-2 mt-2 mb-1 px-2 py-1.5 rounded text-xs text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 border border-dashed border-neutral-300 dark:border-neutral-700"
      >
        <Plus size={14} /> New conversation
      </button>
      {error && <p className="px-3 py-2 text-xs text-red-600">{error}</p>}
      {conversations.map((c) => {
        const active = c.id === activeId;
        const persona = personaName(blocks, c.system_prompt_note_id);
        return (
          <div key={c.id} className="relative group/row">
            <button
              onClick={() => setActive(c.id)}
              className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                active
                  ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium"
                  : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              }`}
            >
              <MessageSquare size={14} className="shrink-0 opacity-60" />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{c.title || "New conversation"}</span>
                {persona && (
                  <span className="block truncate text-[10px] text-blue-600 dark:text-blue-400">
                    persona: {persona}
                  </span>
                )}
              </span>
            </button>
            <div className="absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
              <button
                onClick={() => setPicking((p) => (p === c.id ? null : c.id))}
                title="Set a note as this conversation's persona"
                className={`p-1 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 ${
                  c.system_prompt_note_id ? "text-blue-600 dark:text-blue-400" : "text-neutral-400"
                }`}
              >
                <UserCog size={13} />
              </button>
              <button
                onClick={() => {
                  if (window.confirm("Delete this conversation? This can't be undone.")) {
                    void removeConversation(c.id);
                  }
                }}
                title="Delete conversation"
                className="p-1 rounded text-neutral-400 hover:text-red-600 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {picking === c.id && (
              <div className="absolute right-1 top-8 z-50">
                <NotePicker
                  selectedId={c.system_prompt_note_id}
                  onPick={(noteId) => void setPersona(c.id, noteId)}
                  onClear={() => void setPersona(c.id, null)}
                  onClose={() => setPicking(null)}
                />
              </div>
            )}
          </div>
        );
      })}
      {loaded && conversations.length === 0 && (
        <p className="px-3 py-2 text-xs text-neutral-500">No conversations yet.</p>
      )}

      {loaded && config && (
        <div className="relative mt-2 mx-2 border-t border-neutral-200 dark:border-neutral-800 pt-2">
          <button
            onClick={() => setPicking((p) => (p === "__default__" ? null : "__default__"))}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
            title="Default persona for new conversations"
          >
            <UserCog size={13} className="shrink-0" />
            <span className="truncate">
              Default persona: {defaultName ?? "none"}
            </span>
          </button>
          {picking === "__default__" && (
            <div className="absolute left-1 bottom-9 z-50">
              <NotePicker
                selectedId={defaultPersona}
                onPick={(noteId) => void setDefaultPersona(noteId)}
                onClear={() => void setDefaultPersona(null)}
                onClose={() => setPicking(null)}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

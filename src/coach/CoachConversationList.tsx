import { useEffect } from "react";
import { Plus, MessageSquare } from "lucide-react";
import { useCoach } from "../stores/coach";

/**
 * Sidebar list of coach conversations (shown when the Coach tab is active).
 * Selecting one drives the main-panel chat via the shared coach store.
 */
export function CoachConversationList() {
  const config = useCoach((s) => s.config);
  const conversations = useCoach((s) => s.conversations);
  const activeId = useCoach((s) => s.activeId);
  const loaded = useCoach((s) => s.loaded);
  const error = useCoach((s) => s.error);
  const load = useCoach((s) => s.load);
  const setActive = useCoach((s) => s.setActive);
  const newConversation = useCoach((s) => s.newConversation);

  // Refresh the list whenever the tab is shown.
  useEffect(() => {
    void load();
  }, [load]);

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
        return (
          <button
            key={c.id}
            onClick={() => setActive(c.id)}
            className={`flex items-center gap-2 px-3 py-2 text-sm text-left ${
              active
                ? "bg-neutral-100 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 font-medium"
                : "text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
            }`}
          >
            <MessageSquare size={14} className="shrink-0 opacity-60" />
            <span className="truncate">{c.title || "New conversation"}</span>
          </button>
        );
      })}
      {loaded && conversations.length === 0 && (
        <p className="px-3 py-2 text-xs text-neutral-500">No conversations yet.</p>
      )}
    </div>
  );
}

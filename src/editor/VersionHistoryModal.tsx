import { useEffect, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { ipc, type BlockVersion } from "../lib/ipc";
import { useWorkspace } from "../stores/workspace";

export function VersionHistoryModal({
  blockId,
  onClose,
}: {
  blockId: string;
  onClose: () => void;
}) {
  const [versions, setVersions] = useState<BlockVersion[]>([]);
  const [busy, setBusy] = useState<number | null>(null);
  const reload = useWorkspace((s) => s.reload);

  const refresh = () => ipc.listVersions(blockId).then(setVersions);

  useEffect(() => {
    refresh();
  }, [blockId]);

  const restore = async (v: BlockVersion) => {
    setBusy(v.id);
    try {
      const block = useWorkspace.getState().blocks.find((b) => b.id === blockId);
      if (!block) return;
      await ipc.saveBlocks(
        [
          {
            id: block.id,
            content: v.content,
            position: block.position,
            parent_id: block.parent_id,
            heading: block.heading,
            heading_level: block.heading_level,
          },
        ],
        [],
        "history-restore",
      );
      await reload();
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const currentHash = versions[0]?.content_hash;

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-6">
      <div className="bg-white dark:bg-neutral-900 rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-200 dark:border-neutral-800">
          <h2 className="font-semibold">Version history</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <X size={16} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 space-y-3">
          {versions.length === 0 && (
            <p className="text-sm text-neutral-500">No history yet.</p>
          )}
          {versions.map((v) => {
            const isCurrent = v.content_hash === currentHash;
            return (
              <div
                key={v.id}
                className="border border-neutral-200 dark:border-neutral-800 rounded p-3 text-sm"
              >
                <div className="flex items-center justify-between text-xs text-neutral-500 mb-2">
                  <span>{new Date(v.edited_at).toLocaleString()}</span>
                  <div className="flex items-center gap-2">
                    <span>via {v.source}</span>
                    {isCurrent ? (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 text-[10px]">
                        current
                      </span>
                    ) : (
                      <button
                        onClick={() => restore(v)}
                        disabled={busy === v.id}
                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 text-[11px] disabled:opacity-50"
                      >
                        <RotateCcw size={11} />
                        {busy === v.id ? "Restoring…" : "Restore"}
                      </button>
                    )}
                  </div>
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs">
                  {v.content}
                </pre>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

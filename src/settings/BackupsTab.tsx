import { useEffect, useState } from "react";
import { Download, RotateCcw, Eye, ArrowLeft } from "lucide-react";
import { ipc, type BackupInfo, type BackupPreview } from "../lib/ipc";
import { useWorkspace } from "../stores/workspace";

/**
 * Backups settings tab: list, create, preview, restore, export.
 *
 * Preview opens the chosen backup file as a read-only SQLite connection and
 * surfaces a summary (block count, last edit inside the backup, headings list)
 * so the user can decide whether to restore without first overwriting the
 * live state.
 */
export function BackupsTab() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [previewing, setPreviewing] = useState<BackupInfo | null>(null);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const reload = useWorkspace((s) => s.reload);

  const refresh = async () => setBackups(await ipc.listBackups());

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!previewing) {
      setPreview(null);
      setPreviewErr(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const p = await ipc.previewBackup(previewing.name);
        if (!cancelled) setPreview(p);
      } catch (e: any) {
        if (!cancelled) setPreviewErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewing]);

  const onBackup = async () => {
    setBusy(true);
    try {
      await ipc.createBackup();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onRestore = async (info: BackupInfo) => {
    if (
      !window.confirm(
        `Restore from ${info.name}?\n\nThis replaces the current notes with the contents of this backup. Anything edited since the backup will be lost (unless you make a fresh backup first).`,
      )
    )
      return;
    setBusy(true);
    try {
      await ipc.restoreBackup(info.name);
      await reload();
      await refresh();
      setPreviewing(null);
    } finally {
      setBusy(false);
    }
  };

  const onExport = async () => {
    setBusy(true);
    try {
      const path = await ipc.exportCanvas();
      window.alert(`Wrote markdown export to:\n${path}`);
    } finally {
      setBusy(false);
    }
  };

  if (previewing) {
    return (
      <BackupPreviewView
        info={previewing}
        preview={preview}
        error={previewErr}
        onBack={() => setPreviewing(null)}
        onRestore={() => onRestore(previewing)}
        busy={busy}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button
          onClick={onBackup}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 disabled:opacity-50"
        >
          {busy ? "Working…" : "Backup now"}
        </button>
        <button
          onClick={onExport}
          disabled={busy}
          title="Write the current notes to canvas.md in your workspace folder"
          className="flex items-center gap-1 text-sm px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
        >
          <Download size={14} /> Export markdown
        </button>
      </div>

      <ul className="space-y-1 text-sm">
        {backups.map((b) => (
          <li
            key={b.name}
            className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate">
                {new Date(b.timestamp * 1000).toLocaleString()}
              </div>
              <div className="text-[10px] font-mono text-neutral-400 truncate">
                {b.name} · {(b.size_bytes / 1024).toFixed(0)} KB
              </div>
            </div>
            <button
              onClick={() => setPreviewing(b)}
              disabled={busy}
              title="Preview this backup"
              className="p-1 rounded hover:bg-neutral-100 dark:hover:bg-neutral-700 disabled:opacity-50"
            >
              <Eye size={14} />
            </button>
            <button
              onClick={() => onRestore(b)}
              disabled={busy}
              title="Restore this backup (replaces current notes)"
              className="p-1 rounded hover:bg-amber-50 dark:hover:bg-amber-900/30 text-amber-600 disabled:opacity-50"
            >
              <RotateCcw size={14} />
            </button>
          </li>
        ))}
        {backups.length === 0 && (
          <li className="text-xs text-neutral-500 italic">No backups yet.</li>
        )}
      </ul>

      <p className="text-[10px] text-neutral-400 italic">
        Backups live in <code>.notesapp/backups/</code> next to your workspace.
        A new one is taken automatically once per day on app launch (rolling
        60-day retention).
      </p>
    </div>
  );
}

function BackupPreviewView({
  info,
  preview,
  error,
  onBack,
  onRestore,
  busy,
}: {
  info: BackupInfo;
  preview: BackupPreview | null;
  error: string | null;
  onBack: () => void;
  onRestore: () => void;
  busy: boolean;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <ArrowLeft size={14} /> All backups
        </button>
      </div>

      <div>
        <h3 className="text-sm font-semibold">{info.name}</h3>
        <p className="text-xs text-neutral-500">
          {new Date(info.timestamp * 1000).toLocaleString()} · {(info.size_bytes / 1024).toFixed(0)} KB
        </p>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}
      {!preview && !error && (
        <p className="text-xs text-neutral-500 italic">Loading preview…</p>
      )}
      {preview && (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <dt className="text-neutral-500">Blocks</dt>
            <dd>{preview.block_count.toLocaleString()}</dd>
            <dt className="text-neutral-500">Total characters</dt>
            <dd>{preview.total_chars.toLocaleString()}</dd>
            <dt className="text-neutral-500">Last edit (in backup)</dt>
            <dd>
              {preview.latest_updated_at > 0
                ? new Date(preview.latest_updated_at).toLocaleString()
                : "—"}
            </dd>
            <dt className="text-neutral-500">Earliest block</dt>
            <dd>
              {preview.oldest_created_at > 0
                ? new Date(preview.oldest_created_at).toLocaleString()
                : "—"}
            </dd>
            <dt className="text-neutral-500">Headings</dt>
            <dd>{preview.headings.length}</dd>
          </dl>

          {preview.headings.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold mb-1">Headings</h4>
              <ul className="text-xs space-y-0.5 max-h-64 overflow-y-auto pr-1">
                {preview.headings.map((h) => (
                  <li
                    key={h.id}
                    style={{ paddingLeft: (h.level - 1) * 12 }}
                    className="truncate"
                  >
                    <span className="text-neutral-400 mr-1">
                      {"#".repeat(h.level)}
                    </span>
                    {h.heading}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <button
            onClick={onRestore}
            disabled={busy}
            className="flex items-center gap-1 text-sm px-3 py-1.5 rounded bg-amber-600 hover:bg-amber-700 text-white disabled:opacity-50"
          >
            <RotateCcw size={14} /> Restore this backup
          </button>
        </>
      )}
    </div>
  );
}

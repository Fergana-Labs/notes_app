import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { RefreshCw, Link2, Unlink, Copy } from "lucide-react";
import { ipc, type SyncStatus } from "../lib/ipc";

/**
 * Sync settings: pair this notebook with a relay so the phone can sync to it.
 * The desktop is the workspace owner — pairing mints a workspace and yields a
 * payload (`{ url, workspace_id, token }`) the phone scans as a QR (or pastes
 * as text) from its Settings → Pair screen.
 */
function pairPayload(p: { url: string; workspace_id: string; token: string }): string {
  return JSON.stringify({ url: p.url, workspace_id: p.workspace_id, token: p.token });
}

export function SyncTab() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("http://localhost:3001");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const refresh = async () => setStatus(await ipc.syncStatus());
  useEffect(() => {
    void refresh();
  }, []);

  const pair = async () => {
    setBusy(true);
    setMsg("");
    try {
      await ipc.syncPair(relayUrl.trim());
      await refresh();
    } catch (e) {
      setMsg(`Pair failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const s = await ipc.syncTick();
      setMsg(`Synced — pushed ${s.pushed}, pulled ${s.pulled}, applied ${s.applied}`);
    } catch (e) {
      setMsg(`Sync failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    if (!window.confirm("Unpair this notebook from the relay? The phone will stop syncing to it.")) return;
    await ipc.syncUnpair();
    setMsg("");
    await refresh();
  };

  const paired = Boolean(status?.paired && status.relay_url && status.workspace_id && status.token);
  const payload = paired
    ? pairPayload({ url: status!.relay_url!, workspace_id: status!.workspace_id!, token: status!.token! })
    : "";

  const btn =
    "flex items-center gap-2 text-sm px-3 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50 self-start";

  return (
    <div className="space-y-4">
      {!paired ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold mb-1">Pair with a relay</h3>
          <p className="text-xs text-neutral-500">
            Pair this notebook with a relay so your phone can sync to it. The desktop owns the
            workspace — pairing mints a new one.
          </p>
          <input
            value={relayUrl}
            onChange={(e) => setRelayUrl(e.target.value)}
            placeholder="Relay URL"
            className="w-full text-sm px-2 py-1.5 rounded border border-neutral-300 dark:border-neutral-700 bg-transparent"
          />
          <button onClick={pair} disabled={busy} className={btn}>
            <Link2 size={14} /> {busy ? "Pairing…" : "Pair"}
          </button>
        </section>
      ) : (
        <>
          <section>
            <h3 className="text-sm font-semibold mb-1">Paired</h3>
            <p className="text-xs text-neutral-500">
              Workspace <code className="break-all">{status!.workspace_id!.slice(0, 8)}…</code>
            </p>
          </section>

          <section className="space-y-2">
            <p className="text-xs text-neutral-500">
              On your phone, open <strong>Settings → Pair</strong> and scan this QR code:
            </p>
            <div className="inline-block rounded-lg bg-white p-3 border border-neutral-200">
              <QRCodeSVG value={payload} size={200} />
            </div>
            <p className="text-xs text-neutral-500">…or copy the payload and paste it instead:</p>
            <code className="block text-[11px] px-2 py-1.5 rounded bg-neutral-100 dark:bg-neutral-800 break-all">
              {payload}
            </code>
            <button onClick={() => void navigator.clipboard.writeText(payload)} className={btn}>
              <Copy size={14} /> Copy payload
            </button>
          </section>

          <section className="flex flex-col gap-2">
            <button onClick={syncNow} disabled={busy} className={btn}>
              <RefreshCw size={14} /> {busy ? "Syncing…" : "Sync now"}
            </button>
            <button
              onClick={unpair}
              className="flex items-center gap-2 text-sm px-3 py-1.5 rounded border border-red-300 dark:border-red-900 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 self-start"
            >
              <Unlink size={14} /> Unpair
            </button>
          </section>
        </>
      )}
      {msg && <p className="text-xs text-neutral-500">{msg}</p>}
    </div>
  );
}

import { useEffect, useState } from "react";
import { ipc, PairInfo, SyncStatus } from "../lib/ipc";

/**
 * Sync pairing + status. The desktop is the workspace owner: it pairs with the
 * relay (minting a workspace) and shows a pairing payload the phone scans —
 * `{ url, workspace_id, token }`, the exact shape the mobile QR scanner reads.
 *
 * (A QR image component — e.g. qrcode.react's QRCodeSVG — can wrap `payload`
 * below; it's omitted here only because the dependency couldn't be installed in
 * this environment. The phone can also pair from the copied payload text.)
 */
function pairPayload(p: { url: string; workspace_id: string; token: string }): string {
  return JSON.stringify({ url: p.url, workspace_id: p.workspace_id, token: p.token });
}

export function SyncButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Sync" style={footerBtn}>
        Sync
      </button>
      {open && <SyncModal onClose={() => setOpen(false)} />}
    </>
  );
}

function SyncModal({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [relayUrl, setRelayUrl] = useState("http://localhost:3001");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<string>("");

  const refresh = async () => setStatus(await ipc.syncStatus());
  useEffect(() => {
    void refresh();
  }, []);

  const pair = async () => {
    setBusy(true);
    try {
      const info: PairInfo = await ipc.syncPair(relayUrl.trim());
      void info;
      await refresh();
    } catch (e) {
      setStats(`Pair failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const syncNow = async () => {
    setBusy(true);
    try {
      const s = await ipc.syncTick();
      setStats(`Synced — pushed ${s.pushed}, pulled ${s.pulled}, applied ${s.applied}`);
    } catch (e) {
      setStats(`Sync failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const unpair = async () => {
    await ipc.syncUnpair();
    setStats("");
    await refresh();
  };

  const paired = status?.paired && status.relay_url && status.workspace_id && status.token;
  const payload = paired
    ? pairPayload({ url: status!.relay_url!, workspace_id: status!.workspace_id!, token: status!.token! })
    : "";

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Sync</h3>
          <button onClick={onClose} style={footerBtn}>
            Close
          </button>
        </div>

        {!paired ? (
          <>
            <p style={muted}>Pair this notebook with a relay so your phone can sync to it.</p>
            <input
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder="Relay URL"
              style={input}
            />
            <button onClick={pair} disabled={busy} style={primaryBtn}>
              {busy ? "Pairing…" : "Pair"}
            </button>
          </>
        ) : (
          <>
            <p style={muted}>
              Paired · workspace <code>{status!.workspace_id!.slice(0, 8)}…</code>
            </p>
            <p style={muted}>Scan this on your phone (Settings → Pair), or copy it:</p>
            <textarea readOnly value={payload} style={codeBox} onFocus={(e) => e.currentTarget.select()} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => navigator.clipboard.writeText(payload)} style={footerBtn}>
                Copy
              </button>
              <button onClick={syncNow} disabled={busy} style={primaryBtn}>
                {busy ? "Syncing…" : "Sync now"}
              </button>
              <button onClick={unpair} style={dangerBtn}>
                Unpair
              </button>
            </div>
          </>
        )}
        {stats && <p style={{ ...muted, marginTop: 8 }}>{stats}</p>}
      </div>
    </div>
  );
}

const footerBtn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 8,
  border: "1px solid #E8C98F",
  background: "#FBF5E9",
  color: "#8C5A1F",
  cursor: "pointer",
  fontSize: 13,
};
const primaryBtn: React.CSSProperties = { ...footerBtn, background: "#C66A3D", color: "#fff", border: "none" };
const dangerBtn: React.CSSProperties = { ...footerBtn, color: "#B33B2F", borderColor: "#E3B4AC" };
const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.25)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const modal: React.CSSProperties = {
  width: 420,
  maxWidth: "90vw",
  background: "#FFFCF7",
  borderRadius: 14,
  padding: 20,
  boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const muted: React.CSSProperties = { color: "#6B6358", fontSize: 13, margin: 0 };
const input: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, border: "1px solid #E7DFD1", fontSize: 14 };
const codeBox: React.CSSProperties = {
  width: "100%",
  height: 80,
  fontFamily: "monospace",
  fontSize: 11,
  padding: 8,
  borderRadius: 8,
  border: "1px solid #E7DFD1",
  resize: "none",
};

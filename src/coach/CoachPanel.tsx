import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";

/**
 * Desktop coach — a thin chat UI over the shared, relay-hosted coach agent (the
 * same agent + history the phone talks to). It reads the relay URL + workspace
 * token from sync status and calls the relay's /coach endpoints directly; the
 * agent reasons over the synced notes and can add notes (which sync back here).
 */
interface CoachMessage {
  id: string;
  role: "user" | "coach";
  text: string;
  audio_clip_id: string | null;
  created_at: number;
}

export function CoachButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Coach" style={btn}>
        Coach
      </button>
      {open && <CoachModal onClose={() => setOpen(false)} />}
    </>
  );
}

function CoachModal({ onClose }: { onClose: () => void }) {
  const [cfg, setCfg] = useState<{ url: string; token: string } | null>(null);
  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [input, setInput] = useState("");
  const [deep, setDeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const s = await ipc.syncStatus();
      if (s.paired && s.relay_url && s.token) setCfg({ url: s.relay_url, token: s.token });
    })();
  }, []);

  const refresh = async (c = cfg) => {
    if (!c) return;
    try {
      const res = await fetch(`${c.url}/coach/messages?limit=100`, {
        headers: { Authorization: `Bearer ${c.token}` },
      });
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const data = (await res.json()) as { messages: CoachMessage[] };
      setMessages(data.messages);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    if (cfg) void refresh(cfg);
  }, [cfg]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const send = async () => {
    const text = input.trim();
    if (!text || !cfg) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [
      ...m,
      { id: `tmp-${Date.now()}`, role: "user", text, audio_clip_id: null, created_at: Date.now() },
    ]);
    try {
      const res = await fetch(`${cfg.url}/coach/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ text, deep }),
      });
      if (!res.ok) throw new Error(`send failed: ${res.status}`);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Coach</h3>
          <button onClick={onClose} style={btn}>
            Close
          </button>
        </div>

        {!cfg ? (
          <p style={muted}>Pair this notebook with a relay (Sync) to talk to your coach.</p>
        ) : (
          <>
            <div ref={listRef} style={thread}>
              {messages.length === 0 && (
                <p style={muted}>Ask your coach to help you think through a decision.</p>
              )}
              {messages.map((m) => (
                <div key={m.id} style={m.role === "user" ? userBubble : coachBubble}>
                  {m.text}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <button
                onClick={() => setDeep((d) => !d)}
                style={deep ? { ...btn, background: "#1F2937", color: "#fff" } : btn}
                title="Deep mode (Opus)"
              >
                Think
              </button>
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Message your coach"
                style={textarea}
              />
              <button onClick={() => void send()} disabled={busy} style={primaryBtn}>
                {busy ? "…" : "Send"}
              </button>
            </div>
          </>
        )}
        {error && <p style={{ ...muted, color: "#B33B2F" }}>{error}</p>}
      </div>
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 8,
  border: "1px solid #E8C98F",
  background: "#FBF5E9",
  color: "#8C5A1F",
  cursor: "pointer",
  fontSize: 13,
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#C66A3D", color: "#fff", border: "none" };
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
  width: 460,
  maxWidth: "92vw",
  height: 560,
  maxHeight: "85vh",
  background: "#FFFCF7",
  borderRadius: 14,
  padding: 16,
  boxShadow: "0 10px 40px rgba(0,0,0,0.2)",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const thread: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "8px 2px",
};
const userBubble: React.CSSProperties = {
  alignSelf: "flex-end",
  maxWidth: "85%",
  background: "#C66A3D",
  color: "#fff",
  borderRadius: 14,
  padding: "8px 12px",
  fontSize: 14,
  whiteSpace: "pre-wrap",
};
const coachBubble: React.CSSProperties = {
  alignSelf: "flex-start",
  maxWidth: "85%",
  background: "#F1ECE2",
  color: "#1F2937",
  borderRadius: 14,
  padding: "8px 12px",
  fontSize: 14,
  whiteSpace: "pre-wrap",
};
const textarea: React.CSSProperties = {
  flex: 1,
  minHeight: 38,
  maxHeight: 120,
  borderRadius: 10,
  border: "1px solid #E7DFD1",
  padding: "8px 10px",
  fontSize: 14,
  resize: "none",
};
const muted: React.CSSProperties = { color: "#6B6358", fontSize: 13, margin: "8px 0" };

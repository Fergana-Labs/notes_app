import { ipc } from "../lib/ipc";

/**
 * Coach API client. The coach is a shared, relay-hosted agent over the
 * workspace's synced notes; the desktop is a chat UI talking to it with the
 * workspace token (read from sync status). Conversations let one workspace hold
 * several independent threads; omit `conversation_id` and the relay uses the
 * workspace's default conversation (which is what the phone talks to).
 */
export interface CoachMessage {
  id: string;
  role: "user" | "coach";
  text: string;
  audio_clip_id: string | null;
  created_at: number;
}

export interface CoachConversation {
  id: string;
  title: string;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

export interface CoachConfig {
  url: string;
  token: string;
}

/** Resolve the relay URL + token from sync status, or null if unpaired. */
export async function coachConfig(): Promise<CoachConfig | null> {
  const s = await ipc.syncStatus();
  if (s.paired && s.relay_url && s.token) return { url: s.relay_url, token: s.token };
  return null;
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/**
 * Relays on free hosting (e.g. Render) spin down when idle and return 502/503/504
 * for ~10-40s while waking. Retry transient gateway errors and network blips with
 * backoff so opening Coach or sending a message survives a cold start instead of
 * failing hard. `onWaking` lets the UI show a "waking the relay…" hint.
 */
const TRANSIENT = new Set([502, 503, 504]);
const BACKOFF_MS = [800, 1500, 3000, 5000, 8000, 10000, 10000];

export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  onWaking?: () => void,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    try {
      const res = await fetch(input, init);
      if (!TRANSIENT.has(res.status)) return res;
      lastErr = new Error(`relay ${res.status}`);
    } catch (e) {
      lastErr = e; // network error (relay unreachable / still booting)
    }
    if (attempt < BACKOFF_MS.length) {
      onWaking?.();
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("relay unavailable");
}

export async function listConversations(
  cfg: CoachConfig,
  onWaking?: () => void,
): Promise<CoachConversation[]> {
  const res = await fetchWithRetry(
    `${cfg.url}/coach/conversations`,
    { headers: { Authorization: `Bearer ${cfg.token}` } },
    onWaking,
  );
  if (!res.ok) throw new Error(`conversations failed: ${res.status}`);
  return ((await res.json()) as { conversations: CoachConversation[] }).conversations;
}

export async function createConversation(
  cfg: CoachConfig,
  title = "",
): Promise<CoachConversation> {
  const res = await fetchWithRetry(`${cfg.url}/coach/conversations`, {
    method: "POST",
    headers: authHeaders(cfg.token),
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`create conversation failed: ${res.status}`);
  return ((await res.json()) as { conversation: CoachConversation }).conversation;
}

export async function fetchMessages(
  cfg: CoachConfig,
  conversationId: string,
  limit = 200,
): Promise<CoachMessage[]> {
  const url = `${cfg.url}/coach/messages?conversation_id=${encodeURIComponent(conversationId)}&limit=${limit}`;
  const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!res.ok) throw new Error(`messages failed: ${res.status}`);
  return ((await res.json()) as { messages: CoachMessage[] }).messages;
}

export interface ToolActivity {
  name: string;
  summary: string;
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  onTool: (info: ToolActivity) => void;
  onDone: (info: { reply: string; message_id: string }) => void;
  onError: (detail: string) => void;
}

/**
 * Send a message and stream the reply over SSE (POST + ReadableStream). Parses
 * the `event:`/`data:` frames the relay's /coach/stream endpoint emits.
 */
/** Synthesize speech for a reply on the relay. Returns null if TTS isn't configured (501). */
export async function synthesizeSpeech(cfg: CoachConfig, text: string): Promise<Blob | null> {
  const res = await fetch(`${cfg.url}/coach/tts`, {
    method: "POST",
    headers: authHeaders(cfg.token),
    body: JSON.stringify({ text }),
  });
  if (res.status === 501) return null; // relay has no TTS provider configured
  if (!res.ok) throw new Error(`tts failed: ${res.status}`);
  return await res.blob();
}

export async function streamMessage(
  cfg: CoachConfig,
  conversationId: string,
  text: string,
  opts: { deep?: boolean; voice?: boolean },
  handlers: StreamHandlers,
): Promise<void> {
  let res: Response;
  try {
    // Retry the initial connection through transient gateway errors (deploy /
    // restart windows). Once the body starts streaming we don't retry.
    res = await fetchWithRetry(`${cfg.url}/coach/stream`, {
      method: "POST",
      headers: authHeaders(cfg.token),
      body: JSON.stringify({
        text,
        deep: !!opts.deep,
        voice: !!opts.voice,
        conversation_id: conversationId,
      }),
    });
  } catch (e) {
    handlers.onError(String(e));
    return;
  }
  if (!res.ok || !res.body) {
    handlers.onError(`stream failed: ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (frame: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) return;
    let data: any;
    try {
      data = JSON.parse(dataLines.join("\n"));
    } catch {
      return;
    }
    if (event === "delta") handlers.onDelta(data.text ?? "");
    else if (event === "tool") handlers.onTool({ name: data.name ?? "", summary: data.summary ?? "" });
    else if (event === "done") handlers.onDone(data);
    else if (event === "error") handlers.onError(data.detail ?? "coach error");
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line.
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) dispatch(frame);
    }
  }
  if (buffer.trim()) dispatch(buffer);
}

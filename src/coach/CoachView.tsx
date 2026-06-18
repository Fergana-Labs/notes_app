import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { ulid } from "ulid";
import { Brain, Send, Sparkles, PencilLine, Volume2, VolumeX, FileDown, Check } from "lucide-react";
import { useCoach } from "../stores/coach";
import { useWorkspace } from "../stores/workspace";
import { streamMessage, synthesizeSpeech, type ToolActivity } from "./coachApi";
import { ipc, type CoachMessageRow } from "../lib/ipc";

const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

const MD_CLASS =
  "text-sm leading-relaxed [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 " +
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1 " +
  "[&_li]:my-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_pre]:bg-black/10 dark:[&_pre]:bg-white/10 " +
  "[&_pre]:p-2 [&_pre]:rounded [&_pre]:my-1.5 [&_pre]:overflow-x-auto [&_a]:underline " +
  "[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_blockquote]:border-l-2 " +
  "[&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-500";

function Markdown({ text }: { text: string }) {
  const html = useMemo(() => md.render(text), [text]);
  return <div className={MD_CLASS} dangerouslySetInnerHTML={{ __html: html }} />;
}

const WRITE_TOOLS = new Set(["add_note", "update_note"]);

function ToolChip({ tool }: { tool: ToolActivity }) {
  const isWrite = WRITE_TOOLS.has(tool.name);
  const Icon = isWrite ? PencilLine : Sparkles;
  return (
    <span
      className={`inline-flex items-center gap-1 self-start rounded-full px-2 py-0.5 text-xs ${
        isWrite
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
          : "bg-neutral-200/70 text-neutral-600 dark:bg-neutral-700/60 dark:text-neutral-300"
      }`}
    >
      <Icon size={11} /> {tool.summary}
    </span>
  );
}

/**
 * Coach chat for the main panel. Reads the active conversation's messages from
 * the LOCAL synced replica (so history is offline-capable and the single source
 * of truth is the op log), streams the reply token-by-token over SSE for live
 * UX, then reconciles against the synced messages once the relay's ops land.
 */
export function CoachView() {
  const config = useCoach((s) => s.config);
  const activeId = useCoach((s) => s.activeId);
  const conversations = useCoach((s) => s.conversations);
  const refresh = useCoach((s) => s.refresh);
  const pendingInput = useCoach((s) => s.pendingInput);
  const consumePendingInput = useCoach((s) => s.consumePendingInput);

  const [messages, setMessages] = useState<CoachMessageRow[]>([]);
  const [input, setInput] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deep, setDeep] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [busy, setBusy] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stopSpeaking = () => {
    audioRef.current?.pause();
    audioRef.current = null;
  };
  // Stop any playback when leaving the screen.
  useEffect(() => () => stopSpeaking(), []);

  // Latest-value refs so the poll interval can read state without re-subscribing.
  const busyRef = useRef(false);
  const streamingRef = useRef<string | null>(null);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  const title = conversations.find((c) => c.id === activeId)?.title || "Coach";

  // A note was sent into the coach (from a block's action menu): seed the input
  // box so the user can review/edit before sending. Consumed once.
  useEffect(() => {
    if (pendingInput !== null) {
      const text = consumePendingInput();
      if (text) setInput((cur) => (cur.trim() ? `${cur}\n${text}` : text));
    }
  }, [pendingInput, consumePendingInput]);

  // Copy a coach message into a new note (block) at the bottom of the feed.
  const copyToNote = async (text: string, messageId: string) => {
    const ws = useWorkspace.getState();
    if (!ws.path) return;
    const all = [...ws.blocks].sort((a, b) => a.position - b.position);
    const last = all[all.length - 1];
    try {
      await ws.saveSnapshot([
        {
          id: ulid(),
          content: text,
          position: (last?.position ?? -1) + 1,
          parent_id: last?.parent_id ?? null,
          heading: null,
          heading_level: null,
        },
      ]);
      setCopiedId(messageId);
      window.setTimeout(() => setCopiedId((c) => (c === messageId ? null : c)), 1500);
    } catch (e) {
      setError(String(e));
    }
  };

  // Load from the local replica, and poll so messages synced from other devices
  // (or the 3s background pull) show up. Skip polling mid-send.
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const reload = () =>
      ipc
        .coachListMessages(activeId)
        .then((m) => {
          if (!cancelled) setMessages(m);
        })
        .catch(() => {});
    void reload();
    const id = window.setInterval(() => {
      if (!busyRef.current && streamingRef.current === null) void reload();
    }, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeId]);

  // Keep pinned to the bottom as content grows / streams.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, streaming]);

  const send = async () => {
    const text = input.trim();
    if (!text || !config || !activeId || busy) return;
    setInput("");
    setBusy(true);
    setError("");
    stopSpeaking();
    // Optimistic user bubble (replaced by the canonical synced message after).
    setMessages((m) => [
      ...m,
      {
        id: `tmp-${Date.now()}`,
        conversation_id: activeId,
        role: "user",
        text,
        audio_clip_id: null,
        created_at: Date.now(),
      },
    ]);
    setStreaming("");
    setTools([]);
    let acc = "";
    let done: { reply: string; message_id: string } | null = null;
    try {
      await streamMessage(
        config,
        activeId,
        text,
        { deep, voice: speak },
        {
          onDelta: (d) => {
            acc += d;
            setStreaming(acc);
          },
          onTool: (info) => setTools((t) => [...t, info]),
          onDone: (info) => {
            done = info;
          },
          onError: (detail) => setError(detail),
        },
      );
      // Pull the user + reply ops the relay just authored into the local replica.
      await ipc.syncTick().catch(() => {});
      const result = done as { reply: string; message_id: string } | null;
      const local = await ipc.coachListMessages(activeId).catch(() => null);
      if (local && result && local.some((m) => m.id === result.message_id)) {
        setMessages(local); // canonical
      } else if (result) {
        // Sync hasn't landed yet — show the streamed reply; the poll reconciles.
        setMessages((m) => [
          ...m,
          {
            id: result.message_id,
            conversation_id: activeId,
            role: "coach",
            text: result.reply || acc,
            audio_clip_id: null,
            created_at: Date.now(),
          },
        ]);
      }
      void refresh(); // conversation title/order may have changed

      // Speak the reply (relay TTS) when voice mode is on.
      if (speak && result) {
        try {
          const blob = await synthesizeSpeech(config, result.reply || acc);
          if (blob) {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => URL.revokeObjectURL(url);
            void audio.play().catch(() => {});
          }
        } catch {
          /* TTS is best-effort; ignore failures */
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setStreaming(null);
      setTools([]);
      setBusy(false);
    }
  };

  if (!config) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-neutral-500">
        Pair this notebook with a relay (Settings → Sync) to talk to your coach.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-2 border-b border-neutral-200 dark:border-neutral-800 shrink-0">
        <h2 className="text-sm font-semibold truncate">{title}</h2>
      </div>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {messages.length === 0 && !streaming && (
          <p className="text-sm text-neutral-500 m-auto text-center max-w-sm">
            Ask your coach to help you think through a decision. It can read, search, and add to
            your notes.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={
              m.role === "user"
                ? "self-end max-w-[80%] group/msg flex flex-col items-end"
                : "self-start max-w-[85%] group/msg flex flex-col items-start"
            }
          >
            <div
              className={
                m.role === "user"
                  ? "rounded-2xl px-3 py-2 bg-blue-600 text-white whitespace-pre-wrap text-sm"
                  : "rounded-2xl px-3 py-2 bg-neutral-100 dark:bg-neutral-800"
              }
            >
              {m.role === "coach" ? <Markdown text={m.text} /> : m.text}
            </div>
            {m.role === "coach" && m.text.trim() && (
              <button
                onClick={() => void copyToNote(m.text, m.id)}
                title="Save this reply as a note"
                className="mt-1 flex items-center gap-1 text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 opacity-0 group-hover/msg:opacity-100 transition-opacity"
              >
                {copiedId === m.id ? <Check size={12} /> : <FileDown size={12} />}
                {copiedId === m.id ? "Saved" : "Save to note"}
              </button>
            )}
          </div>
        ))}
        {streaming !== null && (
          <div className="self-start max-w-[85%] rounded-2xl px-3 py-2 bg-neutral-100 dark:bg-neutral-800 flex flex-col gap-1">
            {tools.map((t, i) => (
              <ToolChip key={i} tool={t} />
            ))}
            {streaming ? (
              <Markdown text={streaming} />
            ) : tools.length === 0 ? (
              <span className="text-sm text-neutral-400">…</span>
            ) : null}
          </div>
        )}
      </div>

      {error && <p className="px-4 text-xs text-red-600">{error}</p>}

      <div className="flex items-end gap-2 p-3 border-t border-neutral-200 dark:border-neutral-800 shrink-0">
        <button
          onClick={() => setDeep((d) => !d)}
          title="Deep mode (Opus) — slower, more thorough"
          className={`flex items-center gap-1 text-xs px-2 py-1.5 rounded border self-stretch ${
            deep
              ? "bg-neutral-900 text-white border-neutral-900 dark:bg-neutral-100 dark:text-neutral-900"
              : "border-neutral-300 dark:border-neutral-700 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          <Brain size={14} /> Think
        </button>
        <button
          onClick={() => {
            setSpeak((v) => {
              if (v) stopSpeaking();
              return !v;
            });
          }}
          title={speak ? "Speaking replies aloud — tap to mute" : "Speak replies aloud"}
          className={`flex items-center justify-center w-9 self-stretch rounded border ${
            speak
              ? "bg-neutral-900 text-white border-neutral-900 dark:bg-neutral-100 dark:text-neutral-900"
              : "border-neutral-300 dark:border-neutral-700 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          }`}
        >
          {speak ? <Volume2 size={14} /> : <VolumeX size={14} />}
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
          rows={1}
          className="flex-1 resize-none max-h-32 text-sm px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !input.trim()}
          className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600 text-white disabled:opacity-40"
          title="Send"
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}

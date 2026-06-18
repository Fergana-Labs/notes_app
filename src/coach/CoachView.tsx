import { useEffect, useMemo, useRef, useState } from "react";
import MarkdownIt from "markdown-it";
import { Brain, Send, Sparkles, PencilLine } from "lucide-react";
import { useCoach } from "../stores/coach";
import { fetchMessages, streamMessage, type CoachMessage, type ToolActivity } from "./coachApi";

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

/**
 * Coach chat for the main panel — a thin UI over the relay's shared agent. It
 * renders the active conversation, streams the reply token-by-token, and renders
 * markdown. "Think" toggles the deeper (Opus) mode. No LLM runs here.
 */
export function CoachView() {
  const config = useCoach((s) => s.config);
  const activeId = useCoach((s) => s.activeId);
  const conversations = useCoach((s) => s.conversations);
  const refresh = useCoach((s) => s.refresh);

  const [messages, setMessages] = useState<CoachMessage[]>([]);
  const [input, setInput] = useState("");
  const [deep, setDeep] = useState(false);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const title = conversations.find((c) => c.id === activeId)?.title || "Coach";

  // Load the active conversation's history when it changes.
  useEffect(() => {
    if (!config || !activeId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setError("");
    void fetchMessages(config, activeId)
      .then((m) => !cancelled && setMessages(m))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [config, activeId]);

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
    setMessages((m) => [
      ...m,
      { id: `tmp-${Date.now()}`, role: "user", text, audio_clip_id: null, created_at: Date.now() },
    ]);
    setStreaming("");
    setTools([]);
    let acc = "";
    try {
      await streamMessage(
        config,
        activeId,
        text,
        { deep },
        {
          onDelta: (d) => {
            acc += d;
            setStreaming(acc);
          },
          onTool: (info) => setTools((t) => [...t, info]),
          onDone: (info) => {
            setMessages((m) => [
              ...m,
              {
                id: info.message_id,
                role: "coach",
                text: info.reply || acc,
                audio_clip_id: null,
                created_at: Date.now(),
              },
            ]);
            setStreaming(null);
            setTools([]);
          },
          onError: (detail) => {
            setError(detail);
            setStreaming(null);
            setTools([]);
          },
        },
      );
      // Title/ordering may have changed (first message auto-titles a thread).
      void refresh();
    } catch (e) {
      setError(String(e));
      setStreaming(null);
    } finally {
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
                ? "self-end max-w-[80%] rounded-2xl px-3 py-2 bg-blue-600 text-white whitespace-pre-wrap text-sm"
                : "self-start max-w-[85%] rounded-2xl px-3 py-2 bg-neutral-100 dark:bg-neutral-800"
            }
          >
            {m.role === "coach" ? <Markdown text={m.text} /> : m.text}
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

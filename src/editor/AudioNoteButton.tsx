import { useEffect, useRef, useState } from "react";
import { Loader2, Pause, Play } from "lucide-react";
import { useWorkspace } from "../stores/workspace";
import { ipc } from "../lib/ipc";

/**
 * Plays a voice note's audio, which lives on the relay (not in the synced
 * oplog). Shown only when the block id is in the workspace's `audioIds` set
 * (populated from the relay's audio manifest). On first play we stream the
 * m4a bytes over IPC, wrap them in a Blob, and drive a plain <audio> element.
 */
export function AudioNoteButton({ blockId }: { blockId: string }) {
  const hasAudio = useWorkspace((s) => s.audioIds.includes(blockId));
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  if (!hasAudio) return null;

  const toggle = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (audioRef.current && playing) {
      audioRef.current.pause();
      return;
    }
    if (audioRef.current && !playing) {
      void audioRef.current.play();
      return;
    }
    // First play — fetch the bytes and build a blob URL.
    setLoading(true);
    try {
      const bytes = await ipc.audioFetch(blockId);
      const blob = new Blob([new Uint8Array(bytes)], { type: "audio/mp4" });
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const el = new Audio(url);
      el.onplay = () => setPlaying(true);
      el.onpause = () => setPlaying(false);
      el.onended = () => setPlaying(false);
      audioRef.current = el;
      await el.play();
    } catch (err) {
      console.error("audio playback failed:", err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggle}
      title={playing ? "Pause voice note" : "Play voice note"}
      aria-label={playing ? "Pause voice note" : "Play voice note"}
      className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-emerald-600 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
    >
      {loading ? (
        <Loader2 size={13} className="animate-spin" />
      ) : playing ? (
        <Pause size={13} />
      ) : (
        <Play size={13} />
      )}
    </button>
  );
}

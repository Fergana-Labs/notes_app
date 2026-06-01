import { ulid } from "ulid";
import { ipc } from "./ipc";
import { useWorkspace } from "../stores/workspace";

/**
 * Daily note: a full-screen scratchpad for the day. The draft lives in
 * the settings table (`daily.draft` + `daily.date`). When a new day
 * begins — or the user explicitly flushes — its content is split into
 * blocks (one per horizontal-rule-delimited segment) and appended to the
 * canvas. Inline `#hashtags` in each segment become tags automatically
 * (the backend extracts + indexes them on save).
 */

const DRAFT_KEY = "daily.draft";
const DATE_KEY = "daily.date";

/** Local calendar date as YYYY-MM-DD. */
export function todayStr(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Split a daily-note markdown draft into segments on horizontal-rule
 * lines (`---`, `***`, `___`), ignoring rules inside fenced code. Blank
 * segments are dropped.
 */
export function splitDailyIntoSegments(md: string): string[] {
  const lines = md.split("\n");
  const segs: string[][] = [[]];
  let inFence = false;
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      segs[segs.length - 1].push(line);
      continue;
    }
    if (!inFence && /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      segs.push([]);
      continue;
    }
    segs[segs.length - 1].push(line);
  }
  return segs.map((s) => s.join("\n").trim()).filter((s) => s.length > 0);
}

/**
 * Append a daily-note draft's segments to the canvas as new blocks (at
 * the bottom, in order). Returns how many blocks were created. Inline
 * hashtags are turned into tags server-side.
 */
export async function flushDailyDraft(draft: string): Promise<number> {
  const segments = splitDailyIntoSegments(draft);
  if (segments.length === 0) return 0;
  const ws = useWorkspace.getState();
  const all = [...ws.blocks].sort((a, b) => a.position - b.position);
  let pos = (all[all.length - 1]?.position ?? -1) + 1;
  const inputs = segments.map((content) => ({
    id: ulid(),
    content,
    position: pos++,
    parent_id: null,
    heading: null as string | null,
    heading_level: null as number | null,
  }));
  await ws.saveSnapshot(inputs, []);
  return segments.length;
}

/** Read the stored draft (current day's working copy). */
export async function loadDailyDraft(): Promise<string> {
  const v = await ipc.getSetting(DRAFT_KEY);
  return v ?? "";
}

export async function saveDailyDraft(draft: string): Promise<void> {
  await ipc.setSetting(DRAFT_KEY, draft);
  await ipc.setSetting(DATE_KEY, todayStr());
}

export async function clearDailyDraft(): Promise<void> {
  await ipc.setSetting(DRAFT_KEY, "");
  await ipc.setSetting(DATE_KEY, todayStr());
}

/**
 * If the stored draft belongs to an earlier day, flush it to blocks and
 * start a fresh draft for today. Safe to call on app open and whenever
 * the daily note is opened. No-op when the draft is already today's (or
 * empty).
 */
export async function maybeRolloverDaily(): Promise<void> {
  const [savedDate, savedDraft] = await Promise.all([
    ipc.getSetting(DATE_KEY),
    ipc.getSetting(DRAFT_KEY),
  ]);
  const today = todayStr();
  if (savedDate && savedDate !== today && savedDraft && savedDraft.trim()) {
    await flushDailyDraft(savedDraft);
    await ipc.setSetting(DRAFT_KEY, "");
  }
  if (savedDate !== today) {
    await ipc.setSetting(DATE_KEY, today);
  }
}

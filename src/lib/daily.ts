import { ulid } from "ulid";
import { useWorkspace } from "../stores/workspace";

/**
 * Daily notes: one persisted markdown scratchpad per calendar day,
 * stored in the `daily_notes` table (never auto-destroyed, browsable).
 * "Add to notes" splits a day's note on horizontal rules into canvas
 * blocks; inline `#hashtags` in each segment become tags server-side.
 */

/** Local calendar date as YYYY-MM-DD. */
export function todayStr(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Split a daily-note markdown into segments on horizontal-rule lines
 * (`---`, `***`, `___`), ignoring rules inside fenced code. Blank
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
 * Append the given segments to the canvas as new blocks (bottom, in
 * order). Returns how many blocks were created. The daily note itself is
 * left intact — it's a persistent archive, not a draft.
 */
export async function flushSegmentsToBlocks(
  segments: string[],
): Promise<number> {
  const segs = segments.map((s) => s.trim()).filter((s) => s.length > 0);
  if (segs.length === 0) return 0;
  const ws = useWorkspace.getState();
  const all = [...ws.blocks].sort((a, b) => a.position - b.position);
  let pos = (all[all.length - 1]?.position ?? -1) + 1;
  const inputs = segs.map((content) => ({
    id: ulid(),
    content,
    position: pos++,
    parent_id: null,
    heading: null as string | null,
    heading_level: null as number | null,
  }));
  await ws.saveSnapshot(inputs, []);
  return segs.length;
}

/** Split a daily-note draft and flush every segment. */
export async function flushDailyToBlocks(md: string): Promise<number> {
  return flushSegmentsToBlocks(splitDailyIntoSegments(md));
}

/**
 * Human label for a daily-note date: "Today" / "Yesterday" / weekday for
 * the last week, otherwise a Mon D (and year if not current) date.
 */
export function dailyDateLabel(date: string, now: Date = new Date()): string {
  if (date === todayStr(now)) return "Today";
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (date === todayStr(y)) return "Yesterday";
  const d = parseDate(date);
  if (!d) return date;
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Bucket label used to group older daily notes in the sidebar. */
export function dailyGroupLabel(date: string, now: Date = new Date()): string {
  const d = parseDate(date);
  if (!d) return "Earlier";
  const msDay = 86_400_000;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday.getTime() - d.getTime()) / msDay);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return "This week";
  if (diffDays < 14) return "Last week";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "long" });
  }
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function parseDate(date: string): Date | null {
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

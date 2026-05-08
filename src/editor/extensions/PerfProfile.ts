import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Dev-only typing profiler. Measures the *full* keystroke pipeline, not
 * just PM's dispatch — the v1 of this profiler stopped at Tiptap's
 * `transaction` event, which fires *inside* `editor.dispatchTransaction`
 * before the `update` event (our save callback), the bubble-menu update,
 * any post-tx microtasks, and the next paint. That under-counted real
 * cost and hid bunching (input queueing while the main thread is busy).
 *
 * What we measure now per keystroke (one `[perf]` line each):
 *  - apply       — state.applyTransaction (boundary: t0 → beforeTransaction)
 *  - viewUpdate  — view.updateState (boundary: beforeTransaction → transaction)
 *  - postTx      — emit('update' / focus / etc.) after `transaction` (boundary: transaction → origDispatch return)
 *  - dispatch    — full origDispatch wall-clock (apply + viewUpdate + postTx)
 *  - micro       — work that ran in microtasks queued by the dispatch
 *                  (boundary: origDispatch return → next rAF callback)
 *  - paint       — full t0 → next rAF (the paint *after* this keystroke)
 *
 * Plus passive observers for input latency and long tasks:
 *  - PerformanceObserver `event` / `first-input` — input → paint latency,
 *    independent of our dispatch instrumentation. Catches *queueing*
 *    (bunching) since `processingStart - startTime` is the queue delay.
 *  - PerformanceObserver `longtask` — any task ≥50ms blocking the main
 *    thread, which is what bunches keystrokes.
 *
 * Inspect at runtime via `window.__mochiPerf`:
 *   __mochiPerf.summary()       // tx percentiles
 *   __mochiPerf.recent          // last 100 tx entries with full breakdown
 *   __mochiPerf.input           // last 100 input-timing entries
 *   __mochiPerf.longtasks       // last 50 long tasks
 *   __mochiPerf.slowMs = 4      // lower the warn threshold
 *   __mochiPerf.reset()
 */
interface TxEntry {
  n: number;
  total: number;
  apply: number;
  viewUpdate: number;
  postTx: number;
  dispatch: number;
  micro: number;
  paint: number;
  docChanged: boolean;
  childCount: number;
  ts: number;
}

interface InputEntry {
  type: string;
  duration: number;
  queue: number;
  processing: number;
  ts: number;
}

interface LongTaskEntry {
  duration: number;
  attribution: string;
  ts: number;
}

interface PerfStats {
  txTimes: number[];
  recent: TxEntry[];
  slowest: TxEntry | null;
  input: InputEntry[];
  longtasks: LongTaskEntry[];
  enabled: boolean;
  slowMs: number;
  reset(): void;
  summary(): void;
}

declare global {
  interface Window {
    __mochiPerf?: PerfStats;
  }
}

const RING_TX = 100;
const RING_INPUT = 100;
const RING_LT = 50;

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function ensureStats(): PerfStats {
  if (typeof window === "undefined") {
    return {
      txTimes: [],
      recent: [],
      slowest: null,
      input: [],
      longtasks: [],
      enabled: false,
      slowMs: 8,
      reset() {},
      summary() {},
    };
  }
  if (window.__mochiPerf) return window.__mochiPerf;
  const stats: PerfStats = {
    txTimes: [],
    recent: [],
    slowest: null,
    input: [],
    longtasks: [],
    enabled: true,
    slowMs: 8,
    reset() {
      this.txTimes = [];
      this.recent = [];
      this.slowest = null;
      this.input = [];
      this.longtasks = [];
    },
    summary() {
      if (this.txTimes.length === 0) {
        console.log("[perf] no transactions recorded yet");
        return;
      }
      const totals = this.txTimes;
      const dispatches = this.recent.map((r) => r.dispatch);
      const paints = this.recent.map((r) => r.paint);
      console.log(
        `[perf] tx (${totals.length}): total p50 ${pct(totals, 0.5).toFixed(1)} · p90 ${pct(totals, 0.9).toFixed(1)} · p99 ${pct(totals, 0.99).toFixed(1)} · max ${pct(totals, 1).toFixed(1)}`,
      );
      console.log(
        `[perf] dispatch p50 ${pct(dispatches, 0.5).toFixed(1)} · p90 ${pct(dispatches, 0.9).toFixed(1)} · max ${pct(dispatches, 1).toFixed(1)} ms (apply+view+postTx wall clock)`,
      );
      console.log(
        `[perf] paint    p50 ${pct(paints, 0.5).toFixed(1)} · p90 ${pct(paints, 0.9).toFixed(1)} · max ${pct(paints, 1).toFixed(1)} ms (input → next rAF)`,
      );
      if (this.input.length > 0) {
        const queues = this.input.map((i) => i.queue);
        const procs = this.input.map((i) => i.processing);
        console.log(
          `[perf] input (${this.input.length}): queue p50 ${pct(queues, 0.5).toFixed(1)} · p90 ${pct(queues, 0.9).toFixed(1)} · max ${pct(queues, 1).toFixed(1)} ms (PerformanceEventTiming)`,
        );
        console.log(
          `[perf] input proc p50 ${pct(procs, 0.5).toFixed(1)} · p90 ${pct(procs, 0.9).toFixed(1)} · max ${pct(procs, 1).toFixed(1)} ms`,
        );
      }
      if (this.longtasks.length > 0) {
        const lts = this.longtasks.map((l) => l.duration);
        console.log(
          `[perf] longtasks (${this.longtasks.length}): p50 ${pct(lts, 0.5).toFixed(1)} · p90 ${pct(lts, 0.9).toFixed(1)} · max ${pct(lts, 1).toFixed(1)} ms`,
        );
      }
      if (this.slowest) {
        const s = this.slowest;
        console.log(
          `[perf] slowest tx#${s.n}: total ${s.total.toFixed(1)} · apply ${s.apply.toFixed(1)} · view ${s.viewUpdate.toFixed(1)} · postTx ${s.postTx.toFixed(1)} · micro ${s.micro.toFixed(1)} · paint ${s.paint.toFixed(1)}`,
        );
      }
    },
  };
  window.__mochiPerf = stats;

  // Passive observers — set up once per page. They fire independently of
  // PM/Tiptap and catch work that happens *outside* the dispatch window.
  try {
    const inputObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as any[]) {
        // PerformanceEventTiming.processingStart - startTime is the time
        // the input event spent queued before we ran our handler. Big
        // queue numbers = bunching.
        const queue = entry.processingStart != null ? entry.processingStart - entry.startTime : 0;
        const processing = entry.processingEnd != null && entry.processingStart != null
          ? entry.processingEnd - entry.processingStart
          : 0;
        stats.input.push({
          type: entry.name,
          duration: entry.duration,
          queue,
          processing,
          ts: entry.startTime,
        });
        if (stats.input.length > RING_INPUT) stats.input.shift();
        if (entry.duration >= stats.slowMs * 2) {
          console.warn(
            `[perf-input] ${entry.name} ${entry.duration.toFixed(1)}ms · queue ${queue.toFixed(1)} · proc ${processing.toFixed(1)}`,
          );
        }
      }
    });
    // durationThreshold of 0 captures every input — Chromium defaults to
    // 104ms which would hide everything we care about. Some implementations
    // ignore the option, that's fine.
    (inputObs as any).observe({ type: "event", buffered: true, durationThreshold: 0 });
    (inputObs as any).observe({ type: "first-input", buffered: true });
  } catch {
    /* Event Timing not supported in this WebKit, ignore */
  }

  try {
    const ltObs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const attr = (entry as any).attribution?.[0]?.containerType ?? "main";
        stats.longtasks.push({
          duration: entry.duration,
          attribution: attr,
          ts: entry.startTime,
        });
        if (stats.longtasks.length > RING_LT) stats.longtasks.shift();
        console.warn(
          `[perf-longtask] ${entry.duration.toFixed(0)}ms task at ${entry.startTime.toFixed(0)}ms · ${attr}`,
        );
      }
    });
    ltObs.observe({ entryTypes: ["longtask"] });
  } catch {
    /* longtask not supported in WebKit, that's expected */
  }

  return stats;
}

const perfKey = new PluginKey("mochiPerfProfile");

export const PerfProfile = Extension.create({
  name: "mochiPerfProfile",

  addProseMirrorPlugins() {
    const stats = ensureStats();
    const editor = this.editor;
    let txN = 0;
    // Pending state for the in-flight transaction.
    interface Pending {
      n: number;
      t0: number;
      tApplyEnd: number | null;
      tViewEnd: number | null;
    }
    let pending: Pending | null = null;

    editor.on("beforeTransaction", () => {
      if (pending) pending.tApplyEnd = performance.now();
    });

    editor.on("transaction", () => {
      if (pending) pending.tViewEnd = performance.now();
    });

    return [
      new Plugin({
        key: perfKey,
        view(view) {
          const origDispatch = view.dispatch.bind(view);
          (view as any).dispatch = (tr: any) => {
            if (!stats.enabled) {
              origDispatch(tr);
              return;
            }
            const n = ++txN;
            const t0 = performance.now();
            // Capture our slot in a local — `pending` is the shared write
            // target the editor.on handlers update, but it can be reassigned
            // (or nulled) by re-entrant dispatches. We restore the previous
            // outer pending in `finally` and read our timestamps off `local`,
            // so we're robust to nested calls and to errors in origDispatch.
            const local: Pending = { n, t0, tApplyEnd: null, tViewEnd: null };
            const prevPending = pending;
            pending = local;
            performance.mark(`mochi:tx${n}:start`);
            try {
              origDispatch(tr);
            } finally {
              pending = prevPending;
            }
            const tDispatchEnd = performance.now();
            const tApplyEnd = local.tApplyEnd ?? tDispatchEnd;
            const tViewEnd = local.tViewEnd ?? tDispatchEnd;
            const docChanged = tr.docChanged;
            const childCount = view.state.doc.childCount;

            performance.mark(`mochi:tx${n}:dispatchEnd`);

            // Schedule a rAF to capture paint + microtask cost. The rAF
            // fires after the browser commits this frame.
            const captureN = n;
            const tCaptureT0 = t0;
            const tCaptureViewEnd = tViewEnd;
            const tCaptureDispatchEnd = tDispatchEnd;
            requestAnimationFrame(() => {
              const tPaint = performance.now();
              const total = tPaint - tCaptureT0;
              const apply = tApplyEnd - tCaptureT0;
              const viewUpdate = tCaptureViewEnd - tApplyEnd;
              const postTx = tCaptureDispatchEnd - tCaptureViewEnd;
              const dispatch = tCaptureDispatchEnd - tCaptureT0;
              const micro = tPaint - tCaptureDispatchEnd;
              const paint = total;

              performance.mark(`mochi:tx${captureN}:paint`);
              try {
                performance.measure(
                  `mochi:tx${captureN}`,
                  `mochi:tx${captureN}:start`,
                  `mochi:tx${captureN}:paint`,
                );
              } catch {
                /* mark race */
              }

              const entry: TxEntry = {
                n: captureN,
                total,
                apply,
                viewUpdate,
                postTx,
                dispatch,
                micro,
                paint,
                docChanged,
                childCount,
                ts: tCaptureT0,
              };

              stats.txTimes.push(total);
              if (stats.txTimes.length > RING_TX) stats.txTimes.shift();
              stats.recent.push(entry);
              if (stats.recent.length > RING_TX) stats.recent.shift();
              if (!stats.slowest || total > stats.slowest.total) {
                stats.slowest = entry;
              }

              if (total >= stats.slowMs) {
                console.warn(
                  `[perf] tx#${captureN} ${total.toFixed(1)}ms · apply ${apply.toFixed(1)} · view ${viewUpdate.toFixed(1)} · postTx ${postTx.toFixed(1)} · micro ${micro.toFixed(1)} · cc ${childCount} · doc ${docChanged}`,
                );
              }
            });
          };
          return {};
        },
      }),
    ];
  },
});

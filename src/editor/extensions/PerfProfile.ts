import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Dev-only typing profiler. Wraps the editor view's `dispatch` so every
 * transaction is timed end-to-end — but, critically, the wrapper still
 * calls the original `dispatch`, so Tiptap's `_props.dispatchTransaction`
 * (which is what emits the `transaction` / `update` / `selectionUpdate`
 * events that fire our `onUpdate` save callback and the bubble-menu
 * position update) runs untouched. An earlier version of this profiler
 * called `state.apply` + `view.updateState` directly and bypassed all of
 * that — making dev appear artificially fast because save work, bubble
 * menu updates, etc. were silently being skipped.
 *
 * Breakdown: Tiptap emits `beforeTransaction` after `state.applyTransaction`
 * but before `view.updateState`, and emits `transaction` after the view
 * update finishes. We straddle those two events to split the total into
 * `apply` (state.applyTransaction) vs `viewUpdate` (DOM reconcile +
 * NodeView walks).
 *
 * Output:
 *  - `console.warn` on any transaction slower than `slowMs` (default 8)
 *  - rolling stats on `window.__mochiPerf`: `{ txTimes, slowest, recent }`
 *  - matching `performance.mark()` entries you can record in the WebKit
 *    Inspector → Timelines panel for a real flamegraph.
 *
 * To open the inspector in a Tauri dev build: right-click the window →
 * "Inspect Element" (the WKWebView gives you a regular Web Inspector with a
 * Timelines tab; record while typing 5–10 chars and stop).
 */
interface PerfStats {
  txTimes: number[];
  recent: { n: number; total: number; apply: number; viewUpdate: number; docChanged: boolean; childCount: number; ts: number }[];
  slowest: { n: number; total: number; apply: number; viewUpdate: number; ts: number } | null;
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

const RING_SIZE = 100;

function ensureStats(): PerfStats {
  if (typeof window === "undefined") {
    return {
      txTimes: [],
      recent: [],
      slowest: null,
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
    enabled: true,
    slowMs: 8,
    reset() {
      this.txTimes = [];
      this.recent = [];
      this.slowest = null;
    },
    summary() {
      if (this.txTimes.length === 0) {
        console.log("[perf] no transactions recorded yet");
        return;
      }
      const sorted = [...this.txTimes].sort((a, b) => a - b);
      const sum = sorted.reduce((s, n) => s + n, 0);
      const avg = sum / sorted.length;
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      const max = sorted[sorted.length - 1];
      console.log(
        `[perf] last ${sorted.length} tx: avg ${avg.toFixed(1)}ms · p50 ${p50.toFixed(1)} · p90 ${p90.toFixed(1)} · p99 ${p99.toFixed(1)} · max ${max.toFixed(1)}`,
      );
      if (this.slowest) {
        console.log(
          `[perf] slowest tx#${this.slowest.n}: total ${this.slowest.total.toFixed(1)}ms (apply ${this.slowest.apply.toFixed(1)}, viewUpdate ${this.slowest.viewUpdate.toFixed(1)})`,
        );
      }
    },
  };
  window.__mochiPerf = stats;
  return stats;
}

const perfKey = new PluginKey("mochiPerfProfile");

export const PerfProfile = Extension.create({
  name: "mochiPerfProfile",

  addProseMirrorPlugins() {
    const stats = ensureStats();
    const editor = this.editor;
    let txN = 0;
    // Pending state for the in-flight transaction. Set when our dispatch
    // wrapper enters; consumed by the `transaction` event listener.
    let pending: { n: number; t0: number; tApplyEnd: number | null } | null = null;

    // Tiptap fires `beforeTransaction` after state.applyTransaction but
    // before view.updateState. We use it to mark the boundary between
    // the "apply" and "viewUpdate" slices.
    editor.on("beforeTransaction", () => {
      if (pending) pending.tApplyEnd = performance.now();
    });

    // `transaction` fires after view.updateState completes. We close out
    // the pending entry here (rather than after origDispatch returns)
    // because some Tiptap dispatches (e.g. `editor.view.dispatch` from
    // PM input handlers) re-enter through the wrapped dispatch — but the
    // event is the canonical "transaction finished" signal.
    editor.on("transaction", ({ transaction }) => {
      if (!pending) return;
      const t1 = performance.now();
      const total = t1 - pending.t0;
      const apply = pending.tApplyEnd != null ? pending.tApplyEnd - pending.t0 : 0;
      const viewUpdate = pending.tApplyEnd != null ? t1 - pending.tApplyEnd : total;
      const n = pending.n;
      pending = null;

      performance.mark(`mochi:tx${n}:end`);
      try {
        performance.measure(`mochi:tx${n}`, `mochi:tx${n}:start`, `mochi:tx${n}:end`);
      } catch {
        /* mark race */
      }

      stats.txTimes.push(total);
      if (stats.txTimes.length > RING_SIZE) stats.txTimes.shift();

      const childCount = editor.state.doc.childCount;
      stats.recent.push({
        n,
        total,
        apply,
        viewUpdate,
        docChanged: transaction.docChanged,
        childCount,
        ts: pending ? (pending as any).t0 : t1,
      });
      if (stats.recent.length > RING_SIZE) stats.recent.shift();

      if (!stats.slowest || total > stats.slowest.total) {
        stats.slowest = { n, total, apply, viewUpdate, ts: t1 };
      }

      if (total >= stats.slowMs) {
        console.warn(
          `[perf] tx#${n} ${total.toFixed(1)}ms · apply ${apply.toFixed(1)} · viewUpdate ${viewUpdate.toFixed(1)} · childCount ${childCount} · docChanged ${transaction.docChanged}`,
        );
      }
    });

    return [
      new Plugin({
        key: perfKey,
        view(view) {
          // Wrap `view.dispatch` so we can stamp t0 *before* state.apply
          // runs. CRITICAL: we delegate to the original `view.dispatch`
          // (which routes through Tiptap's `_props.dispatchTransaction`),
          // so all Tiptap event firing — `update`, `transaction`,
          // `selectionUpdate`, the focus/blur path — runs untouched.
          // Bypassing it would silently break onUpdate callbacks and is
          // exactly the bug the previous version of this profiler had.
          const origDispatch = view.dispatch.bind(view);
          (view as any).dispatch = (tr: any) => {
            if (!stats.enabled) {
              origDispatch(tr);
              return;
            }
            const n = ++txN;
            const t0 = performance.now();
            pending = { n, t0, tApplyEnd: null };
            performance.mark(`mochi:tx${n}:start`);
            origDispatch(tr);
            // If `transaction` event didn't fire (e.g. tr suppressed by
            // captureTransaction), drop the pending entry so the next tx
            // starts clean.
            if (pending && pending.n === n) pending = null;
          };
          return {};
        },
      }),
    ];
  },
});

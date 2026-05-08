import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/**
 * Dev-only typing profiler. Wraps `editor.view.dispatch` so every transaction
 * is timed end-to-end (state.apply + view.updateState + DOM reconciliation),
 * and decomposes the cost across the doc state.apply, the view dispatch
 * itself, and a synthetic post-paint marker so we can see what slice of a
 * keystroke is on whom.
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
    return [
      new Plugin({
        key: perfKey,
        view(view) {
          const origDispatch = view.dispatch.bind(view);
          let txN = 0;

          // Wrap view.dispatch so we can time the entire pipeline:
          //   - state.apply across all plugins (`apply` slice)
          //   - view.updateState DOM reconciliation (`viewUpdate` slice)
          // ProseMirror calls `state.apply(tr)` then `view.updateState(state)`
          // back-to-back inside the default dispatch. We split them by
          // re-implementing that here (mirrors the upstream default).
          (view as any).dispatch = (tr: any) => {
            if (!stats.enabled) {
              origDispatch(tr);
              return;
            }
            const n = ++txN;
            performance.mark(`mochi:tx${n}:start`);
            const t0 = performance.now();

            // state.apply
            const t1 = performance.now();
            const newState = view.state.apply(tr);
            const t2 = performance.now();

            // view.updateState — this is the DOM reconcile step
            performance.mark(`mochi:tx${n}:viewUpdate-start`);
            view.updateState(newState);
            performance.mark(`mochi:tx${n}:viewUpdate-end`);
            const t3 = performance.now();

            performance.mark(`mochi:tx${n}:end`);
            try {
              performance.measure(`mochi:tx${n}`, `mochi:tx${n}:start`, `mochi:tx${n}:end`);
              performance.measure(
                `mochi:tx${n}:viewUpdate`,
                `mochi:tx${n}:viewUpdate-start`,
                `mochi:tx${n}:viewUpdate-end`,
              );
            } catch {
              /* mark cleanup races are fine */
            }

            const total = t3 - t0;
            const apply = t2 - t1;
            const viewUpdate = t3 - t2;

            stats.txTimes.push(total);
            if (stats.txTimes.length > RING_SIZE) stats.txTimes.shift();

            const entry = {
              n,
              total,
              apply,
              viewUpdate,
              docChanged: tr.docChanged,
              childCount: newState.doc.childCount,
              ts: t0,
            };
            stats.recent.push(entry);
            if (stats.recent.length > RING_SIZE) stats.recent.shift();

            if (!stats.slowest || total > stats.slowest.total) {
              stats.slowest = { n, total, apply, viewUpdate, ts: t0 };
            }

            if (total >= stats.slowMs) {
              console.warn(
                `[perf] tx#${n} ${total.toFixed(1)}ms · apply ${apply.toFixed(1)} · viewUpdate ${viewUpdate.toFixed(1)} · childCount ${newState.doc.childCount} · docChanged ${tr.docChanged}`,
              );
            }
          };

          return {};
        },
      }),
    ];
  },
});

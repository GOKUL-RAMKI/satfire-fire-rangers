// Webhook dispatch. Every alert is already in the store before this runs (DB-first), so a failed
// webhook is never the only record. Failures are retried with exponential backoff; pending
// dispatches are resumed after a restart.

import type { AlertRecord } from "../shared/types.ts";
import type { Store } from "./store.ts";

export interface Dispatcher {
  enqueue(a: AlertRecord): void;
  resumePending(): Promise<number>;
  idle(): Promise<void>;
  stop(): void;
}

export function webhookBody(url: string, a: AlertRecord): unknown {
  const text = `${a.dataset === "sample" ? "[SAMPLE DATA] " : ""}${a.kind.toUpperCase()} — ${a.placeName} (${a.lat.toFixed(4)}, ${a.lon.toFixed(4)})\n${a.summary}\n\n${a.sitrep.text}`;
  if (/discord(app)?\.com\/api\/webhooks/.test(url)) return { content: text.slice(0, 1990) };
  if (/hooks\.slack\.com/.test(url)) return { text };
  const { dispatch: _d, ...rest } = a;
  void _d;
  return { source: "SATFIRE", alert: rest };
}

export function createDispatcher(opts: {
  store: Store;
  url: string;
  maxAttempts: number;
  backoffMs: number;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}): Dispatcher {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? ((m: string) => console.log(m));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const inflight = new Set<Promise<void>>();
  let stopped = false;

  async function attempt(a: AlertRecord): Promise<void> {
    const now = new Date().toISOString();
    try {
      const res = await fetchFn(opts.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(webhookBody(opts.url, a)),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
      a.dispatch = { ...a.dispatch, status: "sent", attempts: a.dispatch.attempts + 1, lastAttemptAt: now, sentAt: now, nextAttemptAt: null, lastError: null };
      await opts.store.updateAlert(a);
      log(`dispatch: ${a.id} sent`);
    } catch (e) {
      const attempts = a.dispatch.attempts + 1;
      const failed = attempts >= opts.maxAttempts;
      const delay = opts.backoffMs * 2 ** (attempts - 1);
      a.dispatch = {
        ...a.dispatch,
        status: failed ? "failed" : "pending",
        attempts,
        lastAttemptAt: now,
        lastError: e instanceof Error ? e.message : String(e),
        nextAttemptAt: failed ? null : new Date(Date.now() + delay).toISOString(),
      };
      await opts.store.updateAlert(a);
      log(`dispatch: ${a.id} attempt ${attempts} failed (${a.dispatch.lastError})${failed ? " — giving up, record kept" : ` — retry in ${delay} ms`}`);
      if (!failed) schedule(a, delay);
    }
  }

  function schedule(a: AlertRecord, delayMs: number) {
    if (stopped) return;
    const t = setTimeout(() => {
      timers.delete(t);
      const p = attempt(a).finally(() => inflight.delete(p));
      inflight.add(p);
    }, Math.max(0, delayMs));
    timers.add(t);
  }

  return {
    enqueue(a) {
      if (a.dispatch.status === "pending") schedule(a, 0);
    },
    async resumePending() {
      const pending = await opts.store.pendingDispatches();
      for (const a of pending) schedule(a, a.dispatch.nextAttemptAt ? Date.parse(a.dispatch.nextAttemptAt) - Date.now() : 0);
      return pending.length;
    },
    async idle() {
      while (timers.size || inflight.size) await new Promise((r) => setTimeout(r, 20));
    },
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

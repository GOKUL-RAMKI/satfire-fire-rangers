// Lightweight overpass-aware scheduler (plan: Celery/Redis is the scale-out). Polls often inside the
// configured satellite pass windows (UTC) and rarely outside them, instead of a fixed timer.

export function parseWindows(spec: string): [number, number][] {
  return spec
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean)
    .map((w) => {
      const [a, b] = w.split("-").map((t) => {
        const [h, m] = t.split(":").map(Number);
        if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) throw new Error(`bad poll window "${w}"`);
        return h * 60 + m;
      });
      return [a, b] as [number, number];
    });
}

const minuteOfDay = (d: Date) => d.getUTCHours() * 60 + d.getUTCMinutes();

export function inWindow(windows: [number, number][], d: Date): boolean {
  const m = minuteOfDay(d);
  return windows.some(([a, b]) => (a <= b ? m >= a && m <= b : m >= a || m <= b));
}

/** Next run time: every inMin inside a window; outside, the sooner of outMin or the next window start. */
export function nextRun(windows: [number, number][], from: Date, inMin: number, outMin: number): Date {
  if (inWindow(windows, from)) return new Date(from.getTime() + inMin * 60000);
  const m = minuteOfDay(from);
  const untilStart = Math.min(...windows.map(([a]) => (a - m + 1440) % 1440 || 1440));
  return new Date(from.getTime() + Math.min(outMin, untilStart) * 60000);
}

export function createScheduler(opts: { windowsUtc: string; inMin: number; outMin: number; run: () => Promise<void>; log?: (m: string) => void }) {
  const windows = parseWindows(opts.windowsUtc);
  const log = opts.log ?? ((m: string) => console.log(m));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next: Date | null = null;
  const loop = async () => {
    try {
      await opts.run();
    } catch (e) {
      log(`scheduler: run failed (${e instanceof Error ? e.message : String(e)})`);
    }
    next = nextRun(windows, new Date(), opts.inMin, opts.outMin);
    timer = setTimeout(loop, next.getTime() - Date.now());
  };
  return {
    start() {
      void loop();
    },
    stop() {
      if (timer) clearTimeout(timer);
    },
    status() {
      return { windowsUtc: opts.windowsUtc, inWindow: inWindow(windows, new Date()), nextRunAt: next?.toISOString() ?? null };
    },
  };
}

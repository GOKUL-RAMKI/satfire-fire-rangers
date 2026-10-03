import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createAuth } from "../backend/auth.ts";
import { createDispatcher } from "../backend/dispatch.ts";
import { createPhraser, factCheck } from "../backend/llm.ts";
import { inWindow, nextRun, parseWindows } from "../backend/scheduler.ts";
import { startServer } from "../backend/server.ts";
import { alertId, createFileStore } from "../backend/store.ts";
import type { AlertRecord } from "../shared/types.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "satfire-test-"));

// ---------------------------------------------------------------- dispatch

const alert = (over: Partial<AlertRecord> = {}): AlertRecord => ({
  id: alertId("live", "EVT-1", "code_red"),
  dataset: "live",
  eventId: "EVT-1",
  kind: "code_red",
  label: "industrial_fire",
  placeName: "Test site",
  lat: 20,
  lon: 86,
  createdAt: new Date().toISOString(),
  summary: "test",
  sitrep: { text: "SITREP", phrasing: "template", note: "" },
  dispatch: { status: "pending", attempts: 0, lastError: null, lastAttemptAt: null, nextAttemptAt: null, sentAt: null },
  ...over,
});

test("DB-first dispatch: record exists before the webhook, failures retry with backoff, then succeed", async () => {
  let calls = 0;
  const hook = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(calls < 3 ? 500 : 200).end();
  });
  await new Promise<void>((r) => hook.listen(0, r));
  const port = (hook.address() as { port: number }).port;
  const store = createFileStore(tmp());
  const a = alert();
  await store.insertAlert(a);
  assert.equal((await store.listAlerts())[0].dispatch.status, "pending"); // stored before any webhook call
  const d = createDispatcher({ store, url: `http://127.0.0.1:${port}/hook`, maxAttempts: 5, backoffMs: 10, log: () => undefined });
  d.enqueue(a);
  await d.idle();
  const saved = (await store.listAlerts())[0];
  assert.equal(calls, 3);
  assert.equal(saved.dispatch.status, "sent");
  assert.equal(saved.dispatch.attempts, 3);
  hook.close();
});

test("dispatch gives up after max attempts but keeps the record", async () => {
  const store = createFileStore(tmp());
  const a = alert();
  await store.insertAlert(a);
  const failing = (async () => new Response("", { status: 503 })) as typeof fetch;
  const d = createDispatcher({ store, url: "http://example.invalid/hook", maxAttempts: 3, backoffMs: 5, fetchFn: failing, log: () => undefined });
  d.enqueue(a);
  await d.idle();
  const saved = (await store.listAlerts())[0];
  assert.equal(saved.dispatch.status, "failed");
  assert.equal(saved.dispatch.attempts, 3);
  assert.match(saved.dispatch.lastError ?? "", /503/);
});

test("alert insert is idempotent on (dataset, event, kind)", async () => {
  const store = createFileStore(tmp());
  assert.equal((await store.insertAlert(alert())).inserted, true);
  assert.equal((await store.insertAlert(alert({ summary: "again" }))).inserted, false);
  assert.equal((await store.listAlerts()).length, 1);
});

// ---------------------------------------------------------------- LLM phrasing

const TEMPLATE = "SITUATION REPORT [SAMPLE DATA]\nEvent: EVT-FAC-001-20260421\nFacility: Paradip Complex | CPCB Red\nThermal: peak FRP 412 MW.";
const gemini = (text: string, delayMs = 0) =>
  (async (_u: unknown, init?: RequestInit) => {
    await new Promise((r, rej) => {
      const t = setTimeout(r, delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      });
    });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 } }));
  }) as typeof fetch;
const phraser = (fetchFn: typeof fetch, over: Partial<Parameters<typeof createPhraser>[0]> = {}) =>
  createPhraser({ key: "k", model: "m", enabled: true, timeoutMs: 200, maxPerHour: 10, maxPerDay: 10, dailyBudgetUsd: 1, priceInPerMTok: 0.3, priceOutPerMTok: 2.5, fetchFn, ...over });

test("LLM rephrasing that preserves every fact is accepted", async () => {
  const ok = "[SAMPLE DATA] Situation report for EVT-FAC-001-20260421 at Paradip Complex (CPCB Red): peak FRP 412 MW.";
  const r = await phraser(gemini(ok)).phrase(TEMPLATE, ["Paradip Complex"]);
  assert.equal(r.phrasing, "llm");
});

test("LLM output that invents or drops a number is rejected; raw template goes out", async () => {
  const invented = "[SAMPLE DATA] EVT-FAC-001-20260421 at Paradip Complex, CPCB Red: FRP 412 MW, 30 people at risk.";
  const r = await phraser(gemini(invented)).phrase(TEMPLATE, ["Paradip Complex"]);
  assert.equal(r.phrasing, "template");
  assert.equal(r.text, TEMPLATE);
  assert.match(r.note, /fact check/);
  assert.match(factCheck(TEMPLATE, "EVT-FAC-001-20260421 Paradip Complex [SAMPLE DATA]", ["Paradip Complex"]) ?? "", /dropped numbers/);
});

test("LLM timeout or ceilings never block: raw template immediately", async () => {
  const slow = await phraser(gemini("x", 1000), { timeoutMs: 30 }).phrase(TEMPLATE, []);
  assert.equal(slow.phrasing, "template");
  assert.match(slow.note, /timed out/);
  const capped = phraser(gemini(TEMPLATE), { maxPerHour: 0 });
  assert.match((await capped.phrase(TEMPLATE, [])).note, /ceiling/);
  const off = await phraser(gemini(TEMPLATE), { enabled: false }).phrase(TEMPLATE, []);
  assert.equal(off.phrasing, "template");
});

// ---------------------------------------------------------------- auth + scheduler

test("sessions are signed and expire; tampering is rejected", () => {
  const auth = createAuth({ user: "op", password: "pw", secret: "s", ttlHours: 1, secure: false });
  assert.equal(auth.verifyPassword("op", "pw"), true);
  assert.equal(auth.verifyPassword("op", "nope"), false);
  const t = auth.issue("op");
  assert.equal(auth.verify(t), "op");
  assert.equal(auth.verify(t.slice(0, -2) + "xx"), null);
  const expired = createAuth({ user: "op", password: "pw", secret: "s", ttlHours: -1, secure: false });
  assert.equal(expired.verify(expired.issue("op")), null);
});

test("scheduler polls inside overpass windows and waits outside", () => {
  const w = parseWindows("04:30-12:30,16:30-23:59");
  assert.equal(inWindow(w, new Date("2026-04-21T08:00:00Z")), true);
  assert.equal(inWindow(w, new Date("2026-04-21T14:00:00Z")), false);
  assert.equal(nextRun(w, new Date("2026-04-21T08:00:00Z"), 20, 180).toISOString(), "2026-04-21T08:20:00.000Z");
  assert.equal(nextRun(w, new Date("2026-04-21T14:00:00Z"), 20, 180).toISOString(), "2026-04-21T16:30:00.000Z");
  assert.throws(() => parseWindows("25:00-26:00"));
});

// ---------------------------------------------------------------- HTTP API end to end (sample dataset, file store)

const srvP = startServer({
  port: 0,
  firmsKey: "",
  databaseUrl: "",
  dashboardUser: "operator",
  dashboardPassword: "pw",
  passwordGenerated: false,
  runtimeDir: tmp(),
  webhookUrl: "",
  llmEnabled: false,
});
after(async () => (await srvP).close());

// Response bodies are asserted field by field, so a loose JSON type is enough here.
// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;

async function api(path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ status: number; body: Json; cookie: string | null }> {
  const srv = await srvP;
  const res = await fetch(`http://127.0.0.1:${srv.port}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.cookie ? { cookie: init.cookie } : {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null), cookie: res.headers.get("set-cookie") };
}

test("API: every data route requires a session; health does not", async () => {
  assert.equal((await api("/api/health")).status, 200);
  for (const p of ["/api/events", "/api/status", "/api/alerts", "/api/polygons", "/api/facilities", "/api/auth/me"]) assert.equal((await api(p)).status, 401, p);
});

test("API: login, events, review escalates Alert to Code Red, SITREP falls back to template", async () => {
  const bad = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "operator", password: "wrong" }) });
  assert.equal(bad.status, 401);
  const ok = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "operator", password: "pw" }) });
  assert.equal(ok.status, 200);
  assert.match(ok.cookie ?? "", /HttpOnly; SameSite=Strict/);
  const cookie = (ok.cookie ?? "").split(";")[0];

  const events = (await api("/api/events?dataset=sample", { cookie })).body as { id: string; siteKey: string; classification: { tier: string } }[];
  assert.equal(events.length, 15);
  const korba = events.find((e) => e.siteKey === "FAC-003")!;
  assert.equal(korba.classification.tier, "alert");

  const rev = await api(`/api/events/${korba.id}/review`, { method: "POST", cookie, body: JSON.stringify({ dataset: "sample", decision: "confirm", note: "control room confirmed" }) });
  assert.equal(rev.status, 200);
  assert.equal(rev.body.event.classification.tier, "code_red");
  assert.equal(rev.body.alert.kind, "code_red");
  assert.equal(rev.body.alert.dispatch.status, "suppressed_sample");

  const sit = await api(`/api/events/${korba.id}/sitrep`, { method: "POST", cookie, body: JSON.stringify({ dataset: "sample" }) });
  assert.equal(sit.body.phrasing, "template");
  assert.match(sit.body.text, /\[SAMPLE DATA\]/);

  const status = (await api("/api/status?dataset=sample", { cookie })).body;
  assert.equal(status.sample, true);
  assert.equal(status.lastRun.rejected, 6);
  assert.equal((await api("/api/events?dataset=bogus", { cookie })).status, 400);
});

test("API: login is rate-limited after repeated failures", async () => {
  let last = 0;
  for (let i = 0; i < 7; i++) last = (await api("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "x", password: "y" }) })).status;
  assert.equal(last, 429);
});

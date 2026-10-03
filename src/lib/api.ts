// Browser-facing API client. The backend (docs/api.md) is the only data source: there is no
// static-file fallback. Sample data is served by the backend and carries `sample: true`.

import type {
  AlertRecord,
  BacktestReport,
  Dataset,
  Facility,
  PipelineStatus,
  PolygonCollection,
  SatEvent,
} from "../../shared/types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: (() => void) | null = null;

/** Registered by the app shell: any 401 drops the user back to the login screen. */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

async function request<T>(path: string, init: RequestInit = {}, opts: { authCheck?: boolean } = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : typeof body === "string" && body
          ? body
          : `${res.status} ${res.statusText}`;
    if (res.status === 401 && opts.authCheck !== false) onUnauthorized?.();
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

const q = (dataset?: Dataset) => (dataset ? `?dataset=${dataset}` : "");
const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export interface User {
  username: string;
  [k: string]: unknown;
}

export interface SitrepResponse {
  text: string;
  phrasing: "template" | "llm";
  note: string;
}

/** Indicative wind for the downwind wedge (Code Red events only). */
export interface WindInfo {
  available: boolean;
  speedMs?: number | null;
  fromDeg?: number | null;
  toDeg?: number | null;
  at?: string | null;
  source?: string;
  note: string;
}

export interface ReviewResponse {
  event: SatEvent;
  alert: AlertRecord | null;
}

/** The API returns `{ user }`; accept a string or an object for the user field. */
function normUser(raw: unknown): User {
  if (typeof raw === "string") return { username: raw };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const name = typeof o.username === "string" ? o.username : typeof o.name === "string" ? o.name : "operator";
    return { ...o, username: name };
  }
  return { username: "operator" };
}

export const api = {
  login: async (username: string, password: string) =>
    normUser((await request<{ user: unknown }>("/api/auth/login", post({ username, password }), { authCheck: false })).user),
  logout: () => request<{ ok: true }>("/api/auth/logout", post({}), { authCheck: false }),
  me: async () => normUser((await request<{ user: unknown }>("/api/auth/me", {}, { authCheck: false })).user),

  status: (dataset?: Dataset) => request<PipelineStatus>(`/api/status${q(dataset)}`),
  events: (dataset: Dataset) => request<SatEvent[]>(`/api/events${q(dataset)}`),
  event: (id: string, dataset: Dataset) => request<SatEvent>(`/api/events/${encodeURIComponent(id)}${q(dataset)}`),
  review: (id: string, dataset: Dataset, decision: "confirm" | "reject", note: string) =>
    request<ReviewResponse>(`/api/events/${encodeURIComponent(id)}/review`, post({ dataset, decision, note })),
  sitrep: (id: string, dataset: Dataset) =>
    request<SitrepResponse>(`/api/events/${encodeURIComponent(id)}/sitrep`, post({ dataset })),
  wind: (id: string, dataset: Dataset) => request<WindInfo>(`/api/events/${encodeURIComponent(id)}/wind${q(dataset)}`),
  alerts: (dataset?: Dataset) => request<AlertRecord[]>(`/api/alerts${q(dataset)}`),
  facilities: (dataset: Dataset) => request<Facility[]>(`/api/facilities${q(dataset)}`),
  /** Live layer is national scale: pass the visible bbox. Sample needs no bbox. */
  polygons: (dataset: Dataset, bbox?: [number, number, number, number], signal?: AbortSignal) =>
    request<PolygonCollection & { truncated?: boolean }>(
      `/api/polygons${q(dataset)}${bbox ? `&bbox=${bbox.map((v) => v.toFixed(4)).join(",")}` : ""}`,
      { signal },
    ),
  /** `null` when no report has been generated yet (404). */
  backtest: async (): Promise<BacktestReport | null> => {
    try {
      return await request<BacktestReport>("/api/backtest");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  refresh: (dataset: Dataset) => request<PipelineStatus>("/api/pipeline/refresh", post({ dataset })),
};

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 429) return `Too many attempts — rate limited (${e.message}). Wait and try again.`;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

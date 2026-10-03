// LLM phrasing of the SITREP template (Gemini). Phrasing only: the LLM never classifies, never adds
// facts and never gates an alert. Output is fact-checked against the template (every number,
// identifier and name must survive; no new numbers may appear); on failure, timeout, missing key or
// a rate/spend ceiling, the raw template is used immediately.

export interface PhraseResult {
  text: string;
  phrasing: "template" | "llm";
  note: string;
}

export interface PhraserStats {
  enabled: boolean;
  configured: boolean;
  model: string;
  callsLastHour: number;
  callsToday: number;
  spendTodayUsd: number;
  ceilings: { perHour: number; perDay: number; dailyBudgetUsd: number };
}

const NUMBER = /\d+(?:\.\d+)?/g;
const IDS = /\b(?:EVT|FAC|POLY|CELL)-[A-Za-z0-9.-]+/g;

export function factCheck(template: string, output: string, names: string[]): string | null {
  const tNums = new Set(template.match(NUMBER) ?? []);
  const oNums = new Set(output.match(NUMBER) ?? []);
  const missing = [...tNums].filter((n) => !oNums.has(n));
  const added = [...oNums].filter((n) => !tNums.has(n));
  const missingIds = (template.match(IDS) ?? []).filter((id) => !output.includes(id));
  const missingNames = names.filter((n) => n && !output.includes(n));
  const problems: string[] = [];
  if (missing.length) problems.push(`dropped numbers ${missing.slice(0, 5).join(", ")}`);
  if (added.length) problems.push(`introduced numbers ${added.slice(0, 5).join(", ")}`);
  if (missingIds.length) problems.push(`dropped identifiers ${missingIds.slice(0, 3).join(", ")}`);
  if (missingNames.length) problems.push(`dropped names ${missingNames.join(", ")}`);
  if (template.includes("[SAMPLE DATA]") && !output.includes("[SAMPLE DATA]")) problems.push("dropped the SAMPLE DATA marker");
  return problems.length ? problems.join("; ") : null;
}

const PROMPT = `Rephrase the situation report below into clear, plain English for emergency operators.
Rules:
- Keep every number, identifier, facility name, date and unit exactly as written.
- Do not add any fact, number, cause, hazard, chemical, casualty or recommendation that is not in the text.
- Keep the marker [SAMPLE DATA] if it is present.
- Output plain text only.

REPORT:
`;

export function createPhraser(opts: {
  key: string;
  model: string;
  enabled: boolean;
  timeoutMs: number;
  maxPerHour: number;
  maxPerDay: number;
  dailyBudgetUsd: number;
  priceInPerMTok: number;
  priceOutPerMTok: number;
  fetchFn?: typeof fetch;
}) {
  const fetchFn = opts.fetchFn ?? fetch;
  const calls: number[] = [];
  let spendDay = "";
  let spend = 0;
  const today = () => new Date().toISOString().slice(0, 10);

  const stats = (): PhraserStats => {
    const now = Date.now();
    if (spendDay !== today()) {
      spendDay = today();
      spend = 0;
    }
    return {
      enabled: opts.enabled,
      configured: Boolean(opts.key),
      model: opts.model,
      callsLastHour: calls.filter((t) => now - t < 3600000).length,
      callsToday: calls.filter((t) => new Date(t).toISOString().slice(0, 10) === today()).length,
      spendTodayUsd: Math.round(spend * 10000) / 10000,
      ceilings: { perHour: opts.maxPerHour, perDay: opts.maxPerDay, dailyBudgetUsd: opts.dailyBudgetUsd },
    };
  };

  async function phrase(template: string, names: string[]): Promise<PhraseResult> {
    const raw = (note: string): PhraseResult => ({ text: template, phrasing: "template", note });
    if (!opts.enabled) return raw("LLM phrasing disabled (LLM_PHRASING_ENABLED=false); raw template.");
    if (!opts.key) return raw("No GEMINI_API_KEY configured; raw template.");
    const s = stats();
    if (s.callsLastHour >= opts.maxPerHour) return raw("Hourly LLM call ceiling reached; raw template.");
    if (s.callsToday >= opts.maxPerDay) return raw("Daily LLM call ceiling reached; raw template.");
    if (s.spendTodayUsd >= opts.dailyBudgetUsd) return raw("Daily LLM spend ceiling reached; raw template.");
    calls.push(Date.now());
    try {
      const res = await fetchFn(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": opts.key },
        body: JSON.stringify({ contents: [{ parts: [{ text: PROMPT + template }] }], generationConfig: { temperature: 0 } }),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (!res.ok) throw new Error(`Gemini returned ${res.status}`);
      const body = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const u = body.usageMetadata ?? {};
      spend += ((u.promptTokenCount ?? 0) * opts.priceInPerMTok + (u.candidatesTokenCount ?? 0) * opts.priceOutPerMTok) / 1e6;
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("").trim();
      if (!text) throw new Error("empty LLM response");
      const problem = factCheck(template, text, names);
      if (problem) return raw(`LLM output rejected by fact check (${problem}); raw template.`);
      return { text, phrasing: "llm", note: `Phrased by ${opts.model}; every number, identifier and name checked against the template.` };
    } catch (e) {
      const msg = e instanceof Error ? (e.name === "TimeoutError" ? `timed out after ${opts.timeoutMs} ms` : e.message) : String(e);
      return raw(`LLM call failed (${msg}); raw template sent immediately.`);
    }
  }

  return { phrase, stats };
}

export type Phraser = ReturnType<typeof createPhraser>;

// ai-forecast — daily Claude-generated demand forecasts, cached in public.ai_forecast.
// Idempotent per UTC run_date: the first call each day builds forecasts for every
// warehouse/metric and upserts them; later calls return the cache untouched (so cost is
// one Anthropic request per day regardless of how many clients trigger it). The app reads
// the ai_forecast table directly and calls this only when the cache is stale.
//
// Auth: verify_jwt is off (the app authenticates to Supabase with a publishable key that
// isn't a verifiable JWT). Protection = day-idempotency + service-role-only writes, plus
// an optional shared secret: if APP_TRIGGER_TOKEN is set, callers must send it as
// x-trigger-token. Writes use the auto-injected SUPABASE_SERVICE_ROLE_KEY.
//
// Required secret: ANTHROPIC_API_KEY. Optional: AI_FORECAST_MODEL (default claude-opus-5),
// APP_TRIGGER_TOKEN.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("AI_FORECAST_MODEL") || "claude-opus-5";
const TRIGGER_TOKEN = Deno.env.get("APP_TRIGGER_TOKEN") || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-trigger-token",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const HIST_DAYS = 45;   // history window sent to Claude (weeks of weekday seasonality)
const HORIZON = 7;      // days to forecast
const MIN_NONZERO = 3;  // skip series too sparse to forecast

function ymd(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(base: string, n: number) { const d = new Date(base + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }

async function sbGet(path: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`supabase GET ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (TRIGGER_TOKEN && req.headers.get("x-trigger-token") !== TRIGGER_TOKEN)
      return json({ ok: false, error: "unauthorized" }, 401);
    if (!ANTHROPIC_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY not set on the function" }, 500);

    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const today = ymd(new Date());
    const cutoff = addDays(today, -HIST_DAYS);

    // Idempotency: if we already produced forecasts today, return the cache (no Anthropic call).
    const existing = await sbGet(`ai_forecast?select=metric&run_date=eq.${today}&limit=1`);
    if (existing.length && !force)
      return json({ ok: true, cached: true, run_date: today, generated: 0, note: "already generated today" });

    // Pull the durable daily ledgers.
    const [b2c, wod] = await Promise.all([
      sbGet(`b2c_order_daily?select=wh,day,received_orders&day=gte.${cutoff}&order=day.asc`),
      sbGet(`warehouse_order_daily?select=warehouse_code,day,picked_orders,completed_orders&day=gte.${cutoff}&order=day.asc`),
    ]);

    // Build per-series history keyed by an opaque id we echo back through Claude.
    type Pt = [string, number];
    const series: Record<string, { metric: string; wh: string; unit: string; hist: Pt[] }> = {};
    const push = (metric: string, wh: string, unit: string, day: string, v: number) => {
      const id = `${metric}|${wh}`;
      (series[id] ||= { metric, wh, unit, hist: [] }).hist.push([day, Math.max(0, Math.round(Number(v) || 0))]);
    };
    for (const r of b2c) push("b2c_received", r.wh, "B2C orders received/day", r.day, r.received_orders);
    for (const r of wod) {
      push("prod_picked", r.warehouse_code, "orders picked/day", r.day, r.picked_orders);
      push("prod_packed", r.warehouse_code, "orders packed (completed)/day", r.day, r.completed_orders);
    }

    const forecastable = Object.entries(series)
      .filter(([, s]) => s.hist.filter((p) => p[1] > 0).length >= MIN_NONZERO)
      .map(([id, s]) => ({ id, unit: s.unit, history: s.hist }));

    if (!forecastable.length) return json({ ok: true, run_date: today, generated: 0, note: "no series with enough history" });

    // One Anthropic call for every series.
    const prompt =
`You are a demand-forecasting engine for warehouse operations. Forecast the next ${HORIZON} calendar days (starting tomorrow) for each series below.

Today is ${today} (UTC). The final point of a series may be a partial, in-progress day — do not treat a low final value as a downward trend. Weight recent weeks more, respect weekday seasonality (weekends are often lower or zero), and ignore obvious one-off spikes or single-day zero gaps.

Return STRICT JSON ONLY (no markdown, no prose outside the JSON), matching exactly:
{"forecasts":[{"id":"<echo id>","next7":[{"day":"YYYY-MM-DD","value":<integer>=0>}, ... exactly ${HORIZON} items for ${addDays(today,1)} through ${addDays(today,HORIZON)}],"confidence":"low|medium|high","reasoning":"<=180 chars"}]}

Data (history is [date, value] arrays):
${JSON.stringify({ series: forecastable })}`;

    const aReq = {
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    };
    const aRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(aReq),
    });
    if (!aRes.ok) return json({ ok: false, error: `anthropic ${aRes.status}`, detail: (await aRes.text()).slice(0, 800) }, 502);
    const aData = await aRes.json();
    if (aData.stop_reason === "refusal") return json({ ok: false, error: "model refused", detail: aData.stop_details }, 502);
    const text = (aData.content || []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    const s = text.indexOf("{"), e = text.lastIndexOf("}");
    if (s < 0 || e < 0) return json({ ok: false, error: "no JSON in model output", detail: text.slice(0, 800) }, 502);
    let parsed: any;
    try { parsed = JSON.parse(text.slice(s, e + 1)); }
    catch (err) { return json({ ok: false, error: "bad JSON from model", detail: String(err) }, 502); }

    // Map forecasts back to (metric, wh) rows.
    const rows: any[] = [];
    for (const f of (parsed.forecasts || [])) {
      const meta = series[f.id]; if (!meta) continue;
      const h = (f.next7 || [])
        .map((p: any) => ({ day: String(p.day), value: Math.max(0, Math.round(Number(p.value) || 0)) }))
        .filter((p: any) => /^\d{4}-\d{2}-\d{2}$/.test(p.day))
        .slice(0, HORIZON);
      if (!h.length) continue;
      rows.push({
        metric: meta.metric, wh: meta.wh, run_date: today,
        horizon: h, next7_total: h.reduce((a: number, p: any) => a + p.value, 0),
        reasoning: (f.reasoning || "").slice(0, 300),
        confidence: ["low", "medium", "high"].includes(f.confidence) ? f.confidence : null,
        model: MODEL,
      });
    }
    if (!rows.length) return json({ ok: false, error: "model returned no usable forecasts", detail: text.slice(0, 800) }, 502);

    const up = await fetch(`${SB_URL}/rest/v1/ai_forecast?on_conflict=metric,wh,run_date`, {
      method: "POST",
      headers: {
        apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!up.ok) return json({ ok: false, error: `upsert ${up.status}`, detail: (await up.text()).slice(0, 800) }, 500);

    const usage = aData.usage || {};
    return json({ ok: true, run_date: today, generated: rows.length, model: MODEL, usage });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});

// ai-shortage — daily prioritized action plan for clearing each warehouse's shortage
// backlog. Reads shortage_priority_inputs() (age buckets + top brand×type clusters), asks
// Claude once for a ranked list of focus areas per warehouse, caches to public.ai_shortage.
// Idempotent per UTC run_date. Same auth model as ai-forecast / ops-briefing.
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
function ymd(d: Date) { return d.toISOString().slice(0, 10); }

async function sb(path: string, init?: RequestInit) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`supabase ${path}: ${r.status} ${await r.text()}`);
  return r;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (TRIGGER_TOKEN && req.headers.get("x-trigger-token") !== TRIGGER_TOKEN)
      return json({ ok: false, error: "unauthorized" }, 401);
    if (!ANTHROPIC_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY not set on the function" }, 500);

    const force = new URL(req.url).searchParams.get("force") === "1";
    const today = ymd(new Date());

    const existing = await (await sb(`ai_shortage?select=wh&run_date=eq.${today}&limit=1`)).json();
    if (existing.length && !force) return json({ ok: true, cached: true, run_date: today, note: "already generated today" });

    const inputs = await (await sb(`rpc/shortage_priority_inputs`, { method: "POST", body: "{}" })).json();
    if (!Array.isArray(inputs) || !inputs.length) return json({ ok: true, run_date: today, generated: 0, note: "no shortages" });

    const prompt =
`You are an operations analyst. For each warehouse below, produce a prioritized action plan for clearing its shortage backlog (unfulfillable orders waiting on stock).

Rank by impact using two signals: AGE (older orders risk cancellation/complaints — escalate the oldest) and CONCENTRATION (a large cluster of shortages for one brand usually means a supplier/replenishment problem worth a single batched action). order_type is B2C or B2B. Only use the numbers given; don't invent brands or counts.

For each warehouse return 3-5 "priorities", most important first, each: {"title":"short label, name the brand(s) when relevant","count":<int orders it covers>,"urgency":"high|medium|low","action":"one concrete next step"}. Also a one-sentence "summary" of the backlog.

Return STRICT JSON ONLY:
{"warehouses":[{"wh":"<echo exact name>","summary":"...","priorities":[{"title":"...","count":<int>,"urgency":"high|medium|low","action":"..."}]}]}

Data (${today}):
${JSON.stringify(inputs)}`;

    const aRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, thinking: { type: "adaptive" }, output_config: { effort: "low" }, messages: [{ role: "user", content: prompt }] }),
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

    const rows: any[] = [];
    for (const w of (parsed.warehouses || [])) {
      if (!w.wh) continue;
      const priorities = (w.priorities || []).slice(0, 6).map((p: any) => ({
        title: String(p.title || "").slice(0, 160),
        count: Number.isFinite(+p.count) ? Math.max(0, Math.round(+p.count)) : null,
        urgency: ["high", "medium", "low"].includes(p.urgency) ? p.urgency : null,
        action: String(p.action || "").slice(0, 300),
      }));
      rows.push({ run_date: today, wh: String(w.wh), summary: String(w.summary || "").slice(0, 400), priorities, model: MODEL });
    }
    if (!rows.length) return json({ ok: false, error: "model returned no warehouses", detail: text.slice(0, 800) }, 502);

    await sb(`ai_shortage?on_conflict=run_date,wh`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    return json({ ok: true, run_date: today, generated: rows.length, model: MODEL, usage: aData.usage || {} });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});

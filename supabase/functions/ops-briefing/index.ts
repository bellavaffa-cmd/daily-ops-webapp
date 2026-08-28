// ops-briefing — daily plain-English ops brief + staffing recommendation per warehouse.
// Reads a compact per-warehouse snapshot from ops_briefing_inputs(), asks Claude once for
// a briefing + pickers/packers needed, and caches to public.ai_briefing. Idempotent per
// UTC run_date (one Anthropic call/day). Same auth model as ai-forecast (verify_jwt off,
// day-idempotency, service-role writes, optional APP_TRIGGER_TOKEN).
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

    const existing = await (await sb(`ai_briefing?select=scope&run_date=eq.${today}&limit=1`)).json();
    if (existing.length && !force)
      return json({ ok: true, cached: true, run_date: today, note: "already generated today" });

    const inputs = await (await sb(`rpc/ops_briefing_inputs`, { method: "POST", body: "{}" })).json();
    if (!Array.isArray(inputs) || !inputs.length) return json({ ok: true, run_date: today, generated: 0, note: "no warehouse data" });

    const prompt =
`You are the operations analyst for a network of e-commerce fulfillment warehouses. Write a short morning brief for each warehouse below, for a warehouse manager, plus a recommended headcount for the upcoming operating day.

For each warehouse:
- "briefing": 2-3 short sentences in plain English. Call out what matters: yesterday's volumes vs the 7-day average, the forecast for the coming days, notable shortage backlog (open count + average age), and anything unusual. Be specific with numbers. If a field is null/missing, don't invent it.
- "pickers_needed" and "packers_needed": integers for the upcoming operating day. Base them on the forecast daily volume (roughly picked_forecast_next7 / 7 and packed_forecast_next7 / 7) divided by avg_orders_per_picker_day / avg_orders_per_packer_day, then add a small buffer (~10-15%) for absences. Compare to pickers_on_shift_recent / packers_on_shift_recent.
- "staffing_note": one short sentence, e.g. whether current headcount looks sufficient, short, or over-staffed.

Also write one "headline": a single sentence summarizing the whole network this morning (busiest site, any risk to flag).

Return STRICT JSON ONLY (no markdown, no prose outside JSON):
{"headline":"...","warehouses":[{"wh":"<echo exact name>","briefing":"...","pickers_needed":<int>,"packers_needed":<int>,"staffing_note":"..."}]}

Data (${today}, one object per warehouse):
${JSON.stringify(inputs)}`;

    const aRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 8000,
        thinking: { type: "adaptive" }, output_config: { effort: "low" },
        messages: [{ role: "user", content: prompt }],
      }),
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

    // Uniform row shape (PostgREST bulk insert requires identical keys across rows).
    const rows: any[] = [{ run_date: today, scope: "ALL", headline: (parsed.headline || "").slice(0, 600), briefing: null, staffing: null, model: MODEL }];
    for (const w of (parsed.warehouses || [])) {
      if (!w.wh) continue;
      rows.push({
        run_date: today, scope: String(w.wh), headline: null,
        briefing: (w.briefing || "").slice(0, 1200),
        staffing: {
          pickers_needed: Number.isFinite(+w.pickers_needed) ? Math.max(0, Math.round(+w.pickers_needed)) : null,
          packers_needed: Number.isFinite(+w.packers_needed) ? Math.max(0, Math.round(+w.packers_needed)) : null,
          note: (w.staffing_note || "").slice(0, 300),
        },
        model: MODEL,
      });
    }
    if (rows.length <= 1) return json({ ok: false, error: "model returned no warehouses", detail: text.slice(0, 800) }, 502);

    await sb(`ai_briefing?on_conflict=run_date,scope`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    return json({ ok: true, run_date: today, generated: rows.length - 1, model: MODEL, usage: aData.usage || {} });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});

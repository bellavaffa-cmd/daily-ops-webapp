// ai-weekly-report — weekly performance report per warehouse (last complete week vs the
// prior week). Reads weekly_report_inputs(), asks Claude once for a summary + wins +
// concerns per warehouse plus a network exec summary, caches to public.ai_weekly_report.
// Idempotent per period_end (one Anthropic call per week). Same auth model as the others.
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
    const inputs = await (await sb(`rpc/weekly_report_inputs`, { method: "POST", body: "{}" })).json();
    const periodEnd = inputs?.period_end, periodStart = inputs?.period_start;
    const whs = inputs?.warehouses || [];
    if (!periodEnd || !Array.isArray(whs) || !whs.length) return json({ ok: true, generated: 0, note: "no data for the week" });

    const existing = await (await sb(`ai_weekly_report?select=scope&period_end=eq.${periodEnd}&limit=1`)).json();
    if (existing.length && !force) return json({ ok: true, cached: true, period_end: periodEnd, note: "already generated for this week" });

    const prompt =
`You are the operations analyst for a network of e-commerce fulfillment warehouses. Write a weekly performance report for the week ${periodStart} to ${periodEnd}, comparing to the prior week.

For each warehouse:
- "summary": 2-3 sentences on the week — outbound volume (picked/packed) vs the prior week (state the % change and direction), throughput per person, and the shortage backlog. Be specific with numbers. If received_week is null the demand feed wasn't available for that week — say briefly that inbound isn't tracked yet rather than treating it as zero.
- "wins": up to 3 short bullet strings (things that went well).
- "concerns": up to 3 short bullet strings (things to fix / watch).

Also write "exec_summary": 2-3 sentences summarizing the whole network's week (biggest movers, network-wide risks).

Return STRICT JSON ONLY:
{"exec_summary":"...","warehouses":[{"wh":"<echo exact name>","summary":"...","wins":["..."],"concerns":["..."]}]}

Data:
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

    const arr = (x: any) => Array.isArray(x) ? x.map((t: any) => String(t).slice(0, 240)).slice(0, 4) : [];
    const rows: any[] = [{ period_end: periodEnd, scope: "ALL", period_start: periodStart, summary: String(parsed.exec_summary || "").slice(0, 800), sections: null, model: MODEL }];
    for (const w of (parsed.warehouses || [])) {
      if (!w.wh) continue;
      rows.push({
        period_end: periodEnd, scope: String(w.wh), period_start: periodStart,
        summary: String(w.summary || "").slice(0, 1200),
        sections: { wins: arr(w.wins), concerns: arr(w.concerns) },
        model: MODEL,
      });
    }
    if (rows.length <= 1) return json({ ok: false, error: "model returned no warehouses", detail: text.slice(0, 800) }, 502);

    await sb(`ai_weekly_report?on_conflict=period_end,scope`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    return json({ ok: true, period_start: periodStart, period_end: periodEnd, generated: rows.length - 1, model: MODEL, usage: aData.usage || {} });
  } catch (err) {
    return json({ ok: false, error: String(err) }, 500);
  }
});

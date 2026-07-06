import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { getValidToken } from "@/lib/qbo-reclass";
import { fetchAllAccounts } from "@/lib/qbo";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * GET /api/today/client-answers/[id]/suggestions
 *
 * Alternatives for the "apply as a different account" dropdown: the client's
 * live P&L-side chart, with the 5 accounts most similar to the CLIENT'S pick
 * ranked first by a fast Haiku call (e.g. pick "Subcontractors" → the labor
 * options). Falls back to a token-overlap heuristic if the AI call fails, so
 * the dropdown always works.
 */
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const service = createServiceSupabase();
  const { data: actor } = await service.from("users").select("role").eq("id", user.id).single();
  if (!["admin", "lead", "bookkeeper"].includes((actor as any)?.role || "")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data: row } = await (service as any)
    .from("reclassifications")
    .select(
      "id, vendor_name, description, transaction_amount, from_account_name, client_response_account, client_response_note, reclass_jobs!reclass_job_id(client_links(id, qbo_realm_id))"
    )
    .eq("id", id)
    .single();
  if (!row) return NextResponse.json({ error: "Row not found" }, { status: 404 });
  const clientLink = row.reclass_jobs?.client_links;
  if (!clientLink) return NextResponse.json({ error: "Client not found" }, { status: 404 });

  const accessToken = await getValidToken(clientLink.id, service as any);
  const accounts = await fetchAllAccounts(clientLink.qbo_realm_id, accessToken);
  const PNL = new Set(["Income", "Expense", "Cost of Goods Sold", "Other Income", "Other Expense"]);
  const candidates = accounts
    .filter(
      (a: any) =>
        a.Active !== false &&
        PNL.has(a.AccountType) &&
        !/ask my accountant|uncategor/i.test(a.Name)
    )
    .map((a: any) => ({ id: a.Id, name: a.Name, type: a.AccountType }));

  const pick = row.client_response_account || row.client_response_note || "";
  let suggestions: Array<{ id: string; name: string; reason: string }> = [];

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system:
        "You suggest bookkeeping account alternatives for a painting-contractor bookkeeper. Return STRICT JSON only: an array of up to 5 objects {\"name\": string, \"reason\": string} where name is copied EXACTLY from the provided chart and reason is under 8 words. Rank the closest conceptual matches to the client's pick first (e.g. a pick of 'Subcontractors' should surface the labor/contract-labor/COGS-labor options). Never invent account names.",
      messages: [
        {
          role: "user",
          content: `Transaction: ${row.vendor_name || row.description || "unknown"} · $${row.transaction_amount} · currently in "${row.from_account_name}".
Client's pick/answer: "${pick}"
Their chart (name · type):
${candidates.map((c: { name: string; type: string }) => `${c.name} · ${c.type}`).join("\n")}`,
        },
      ],
    });
    const text = resp.content[0]?.type === "text" ? resp.content[0].text : "[]";
    const parsed = JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
    const byName = new Map(candidates.map((c: any) => [c.name.toLowerCase(), c]));
    for (const s of parsed) {
      const hit: any = byName.get(String(s.name || "").toLowerCase());
      if (hit && hit.name.toLowerCase() !== pick.toLowerCase()) {
        suggestions.push({ id: hit.id, name: hit.name, reason: String(s.reason || "").slice(0, 60) });
      }
      if (suggestions.length >= 5) break;
    }
  } catch {
    /* fall through to heuristic */
  }

  if (suggestions.length === 0) {
    // Token-overlap fallback: candidates sharing words with the pick first.
    const tokens = pick.toLowerCase().split(/[^a-z]+/).filter((t: string) => t.length > 3);
    suggestions = candidates
      .map((c: any) => ({
        ...c,
        score: tokens.reduce((s: number, t: string) => s + (c.name.toLowerCase().includes(t) ? 1 : 0), 0),
      }))
      .filter((c: any) => c.score > 0 && c.name.toLowerCase() !== pick.toLowerCase())
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, 5)
      .map((c: any) => ({ id: c.id, name: c.name, reason: "similar name" }));
  }

  return NextResponse.json({ ok: true, suggestions, all: candidates });
}

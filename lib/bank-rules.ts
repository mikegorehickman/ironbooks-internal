import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeVendorForLookup } from "./vendor-knowledge";

/**
 * Create-or-update a bank rule and immediately activate it — the single shared
 * implementation behind every "approve → teach a rule" path (portal reclass
 * requests, from-reclass, and the daily-review learning loop). Upserts on
 * (client_link_id, vendor_pattern) then flips status to 'active' so SNAP's
 * daily-recon engine applies it to future transactions.
 *
 * Best-effort by contract: callers wrap this so a rule hiccup never reverses an
 * already-successful QBO write. Returns whether a rule row resulted.
 *
 * NOTE: vendor_pattern is matched at recon time via normalizeVendorForLookup,
 * so we store the normalized form for a clean, collision-light key.
 */
export async function upsertActivateRule(
  service: SupabaseClient,
  params: {
    client_link_id: string;
    vendor: string;                 // raw vendor/payee text; normalized here
    target_account_name: string;
    created_by?: string | null;
    match_type?: string;            // default CONTAINS
    sample_descriptions?: string[];
    transaction_count?: number;
    total_amount?: number;
  }
): Promise<{ created: boolean; id?: string }> {
  const pattern = normalizeVendorForLookup(params.vendor || "").toUpperCase().trim();
  if (!pattern || !params.target_account_name) return { created: false };

  const { data: upserted, error } = await (service as any)
    .from("bank_rules")
    .upsert(
      [
        {
          client_link_id: params.client_link_id,
          vendor_pattern: pattern,
          match_type: params.match_type || "CONTAINS",
          target_account_name: params.target_account_name,
          status: "approved",
          ai_confidence: null,
          ai_reasoning: null,
          requires_approval: false,
          sample_descriptions: params.sample_descriptions || [],
          transaction_count: params.transaction_count ?? 0,
          total_amount: params.total_amount ?? 0,
          created_by: params.created_by ?? null,
        },
      ],
      { onConflict: "client_link_id,vendor_pattern" }
    )
    .select("id");

  if (error || !upserted || upserted.length === 0) return { created: false };

  const id = (upserted as { id: string }[])[0].id;
  await (service as any).from("bank_rules").update({ status: "active" }).eq("id", id);
  return { created: true, id };
}

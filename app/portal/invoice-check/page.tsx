import { redirect } from "next/navigation";
import { createServiceSupabase } from "@/lib/supabase";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { InvoiceCheckClient } from "./invoice-check-client";

export const dynamic = "force-dynamic";

/**
 * /portal/invoice-check — "which of these invoices are still outstanding?"
 *
 * The client-facing leg of the phantom-A/R cleanup: one card per open
 * invoice the bookkeeper sent for review, with machine-proposed payment
 * matches so most answers are a single tap. Framed as confirming what's
 * outstanding (which it genuinely is — the "still owed" answers become the
 * collections list), never as "help us fix our books."
 */
export default async function InvoiceCheckPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) redirect("/portal");
  const ctx = ctxResult.ctx;
  const service = createServiceSupabase();

  const { data: session } = await (service as any)
    .from("ar_match_sessions")
    .select("id, status, created_at")
    .eq("client_link_id", ctx.clientLinkId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let items: any[] = [];
  if (session) {
    const { data } = await (service as any)
      .from("ar_match_items")
      .select("id, qbo_invoice_id, doc_number, customer_name, txn_date, amount, balance, candidates, answer, answered_at, outcome")
      .eq("session_id", (session as any).id)
      .order("txn_date", { ascending: true });
    items = (data as any[]) || [];
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <InvoiceCheckClient
        clientName={ctx.clientName}
        hasSession={!!session}
        initialItems={items}
      />
    </div>
  );
}

import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts } from "@/lib/qbo";
import { PortalErrorState } from "../error-state";
import { CategorizeClient, type AskRow, type AccountOption } from "./categorize-client";
import { Tags } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * /portal/categorize — the client's answer screen for ask-client reclass
 * rows. Each unidentified transaction gets a dropdown built from THEIR
 * live QBO chart of accounts, grouped so intra-company transfers are a
 * first-class pick:
 *   - "Money moved between my accounts" → their Bank / Credit Card accounts
 *   - "Business categories"             → Income + Expense accounts
 *   - "Something else / not sure"       → free-text note
 *
 * Answers never touch QBO directly — they land on the reclass row
 * (client_response_*) and ride one from_client message to the bookkeeper's
 * /today queue for confirmation.
 */
export default async function CategorizePage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  const service = createServiceSupabase() as any;

  // Every reclass job for this client → its ask_client rows.
  const { data: jobs } = await service
    .from("reclass_jobs")
    .select("id")
    .eq("client_link_id", ctx.clientLinkId);
  const jobIds = ((jobs as any[]) || []).map((j) => j.id);

  let open: AskRow[] = [];
  let answered: AskRow[] = [];
  if (jobIds.length > 0) {
    const { data: rows } = await service
      .from("reclassifications")
      .select(
        "id, transaction_date, transaction_amount, vendor_name, description, from_account_name, client_response_account, client_response_note, client_responded_at"
      )
      .in("reclass_job_id", jobIds)
      .eq("decision", "ask_client")
      .order("transaction_date", { ascending: true })
      .limit(500);
    for (const r of (rows as any[]) || []) {
      const row: AskRow = {
        id: r.id,
        date: r.transaction_date,
        amount: r.transaction_amount,
        label: (r.vendor_name && r.vendor_name !== "Unknown vendor" ? r.vendor_name : null) || r.description || "Unlabeled transaction",
        detail: r.vendor_name && r.description && r.vendor_name !== r.description ? r.description : null,
        fromAccount: r.from_account_name,
        responseAccount: r.client_response_account,
        responseNote: r.client_response_note,
      };
      if (r.client_responded_at) answered.push(row);
      else open.push(row);
    }
  }

  // Dropdown options from the client's LIVE chart of accounts.
  let transferOptions: AccountOption[] = [];
  let categoryOptions: AccountOption[] = [];
  let accountsError = false;
  try {
    const accounts = await fetchAllAccounts(ctx.qboRealmId, ctx.accessToken);
    const active = accounts.filter((a) => a.Active !== false);
    transferOptions = active
      .filter((a) => a.AccountType === "Bank" || a.AccountType === "Credit Card")
      .map((a) => ({ name: a.Name, fqn: a.FullyQualifiedName || a.Name }));
    categoryOptions = active
      .filter((a) => a.Classification === "Expense" || a.Classification === "Revenue")
      .sort((a, b) => (a.FullyQualifiedName || a.Name).localeCompare(b.FullyQualifiedName || b.Name))
      .map((a) => ({ name: a.Name, fqn: a.FullyQualifiedName || a.Name }));
  } catch {
    accountsError = true; // dropdowns degrade to "Other + note" only
  }

  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-teal/20 blur-2xl" />
        <div className="relative">
          <div className="text-xs text-white/60 uppercase tracking-wider font-semibold flex items-center gap-1.5">
            <Tags size={13} /> Categorize transactions
          </div>
          <h1 className="text-3xl font-bold mt-1">Help us label these</h1>
          <p className="text-sm text-white/70 mt-1 max-w-xl">
            Your bookkeeping team found {open.length === 0 ? "no" : open.length} transaction
            {open.length === 1 ? "" : "s"} they couldn&apos;t identify with certainty. Pick what each
            one was and we&apos;ll take it from there — your books aren&apos;t changed until your
            bookkeeper confirms.
          </p>
        </div>
      </div>

      <CategorizeClient
        open={open}
        answered={answered}
        transferOptions={transferOptions}
        categoryOptions={categoryOptions}
        accountsError={accountsError}
      />
    </div>
  );
}

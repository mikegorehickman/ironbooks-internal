import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { WorkflowStepper } from "@/components/WorkflowStepper";
import { createServerSupabase, createServiceSupabase } from "@/lib/supabase";
import { fetchAllAccounts, getValidToken, QBOReauthRequiredError } from "@/lib/qbo";
import { redirect } from "next/navigation";
import { buildRuleCandidates, type RuleSourceRow } from "@/lib/rules-eligibility";
import { BankRulesFromReclassClient } from "./bank-rules-client";

export default async function BankRulesFromReclassPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/auth/login");

  const service = createServiceSupabase();

  const { data: job } = await service
    .from("reclass_jobs")
    .select("id, client_link_id, workflow, status, date_range_start, date_range_end, jurisdiction")
    .eq("id", id)
    .single();

  if (!job) {
    return (
      <AppShell>
        <TopBar title="Job Not Found" />
        <div className="px-8 py-6">
          <div className="p-4 bg-red-50 text-red-800 rounded-lg">Reclass job not found.</div>
        </div>
      </AppShell>
    );
  }

  const { data: clientLink } = await service
    .from("client_links")
    .select("client_name, qbo_realm_id, industry")
    .eq("id", job.client_link_id)
    .single();

  const clientName = (clientLink as any)?.client_name || "Client";
  const qboRealmId = (clientLink as any)?.qbo_realm_id;

  // The dropdown universe is the MASTER COA — the account set we set up
  // for this industry/jurisdiction — not the client's raw QBO list (which
  // is full of one-off Depreciation lines, old loans, etc.). The master
  // names are resolved against live QBO accounts so each option still
  // carries a real QBO account id. Same source + fallback chain as the
  // reclass review dropdown.
  const jurisdiction = ((job as any).jurisdiction as string) || "US";
  const industry = ((clientLink as any)?.industry as string) || "painters";
  let masterNames = new Set<string>();
  {
    let res = await service
      .from("master_coa")
      .select("account_name")
      .eq("jurisdiction", jurisdiction)
      .eq("industry", industry)
      .eq("is_parent", false);
    if (!res.data || res.data.length === 0) {
      res = await service
        .from("master_coa")
        .select("account_name")
        .eq("jurisdiction", jurisdiction)
        .eq("industry", "painters")
        .eq("is_parent", false);
    }
    masterNames = new Set(
      ((res.data as any[]) || []).map((r) => String(r.account_name).toLowerCase())
    );
  }

  // Resolve master names → live QBO accounts (rules need a QBO account id).
  // Fail-soft: if QBO is unreachable, dropdowns get an empty list and the
  // row shows the proposed account as a read-only label.
  //
  // Matching master COA names to live QBO names is brittle under an exact
  // compare: master names are stylized templates ("Direct Field Labor –
  // Painting", "Paint & Materials", "Equipment Rental (Job-Specific)")
  // while live QBO names are plain. Normalize BOTH sides (case, en/em-dash
  // variants, &→and, punctuation→space) so curated master accounts actually
  // resolve to the client's QBO account ids instead of silently dropping
  // out of the dropdown.
  const normName = (s: string) =>
    String(s || "")
      .toLowerCase()
      .replace(/[‒–—―]/g, "-")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const masterNorm = new Set([...masterNames].map(normName));

  let availablePnLAccounts: Array<{ id: string; name: string; type: string }> = [];
  let otherActiveAccounts: Array<{ id: string; name: string; type: string }> = [];
  if (qboRealmId) {
    try {
      const accessToken = await getValidToken(job.client_link_id, service as any);
      const allAccounts = await fetchAllAccounts(qboRealmId, accessToken);
      const active = allAccounts
        .filter((a) => a.Active !== false)
        .map((a) => ({ id: a.Id, name: a.Name, type: a.AccountType || "" }));
      // Split into master-matched (curated) vs everything else. We surface
      // BOTH so the master COA is the default focus but no real account is
      // ever unselectable (the prior exact-match filter could leave the
      // bookkeeper unable to pick the account they needed).
      for (const a of active) {
        if (masterNorm.has(normName(a.name))) availablePnLAccounts.push(a);
        else otherActiveAccounts.push(a);
      }
      availablePnLAccounts.sort((a, b) => a.name.localeCompare(b.name));
      otherActiveAccounts.sort((a, b) => a.name.localeCompare(b.name));
      console.log(
        `[bank-rules ${id}] QBO ${active.length} active accounts; master-matched ${availablePnLAccounts.length} / other ${otherActiveAccounts.length} (${masterNorm.size} master names, industry=${industry}/${jurisdiction})`
      );
    } catch (err: any) {
      if (err instanceof QBOReauthRequiredError) redirect(err.reconnectUrl);
      console.warn(`[bank-rules ${id}] Could not fetch accounts:`, err.message);
    }
  }

  // Pull EVERY classification row that has a vendor name — across every
  // decision type. Goal: the bookkeeper sees one card per unique vendor
  // in this job and can opt every one of them into a permanent rule.
  // Even vendors with no AI-picked target are surfaced (with an empty
  // dropdown the bookkeeper fills in). Even 'skip' rows (already_correct
  // mappings) are pulled — those vendors are perfect rule candidates
  // because the mapping is already proven right.
  //
  // The only filter is `vendor_name IS NOT NULL` — without a vendor name
  // there's no pattern to build a rule from.
  // Pull `description` too so the unknown-vendor fallback can group by
  // the bank descriptor (the "second line" on each card). Without this,
  // every "Unknown vendor" row collapses into a single mega-group that's
  // impossible to categorize meaningfully.
  const { data: rows } = await service
    .from("reclassifications")
    .select(
      "vendor_name, vendor_pattern_normalized, description, to_account_id, to_account_name, bookkeeper_override_target_id, bookkeeper_override_target_name, transaction_amount, decision"
    )
    .eq("reclass_job_id", id);

  // SHARED grouping + eligibility (lib/rules-eligibility.ts, D14) — the same
  // function the POST route uses, so what this page shows is exactly what
  // creating will do: unknown-vendor rows group by bank description, `skip`
  // (already-correct) rows count as proven-right rule seeds, `rejected` and
  // no-vendor/no-description rows are excluded WITH visible counts.
  const { candidates, excluded } = buildRuleCandidates((rows || []) as RuleSourceRow[]);

  // Pull existing bank rules for this client so we can exclude vendors that
  // already have a rule pushed to QBO — no point re-creating the same rule.
  // Vendors with a local-only bank_rules row (pushed_to_qbo=false) DO stay
  // visible so the bookkeeper can re-push them.
  const { data: existingRules } = await service
    .from("bank_rules")
    .select("vendor_pattern, pushed_to_qbo")
    .eq("client_link_id", job.client_link_id);

  function normalizePattern(s: string): string {
    return s.toUpperCase().replace(/\s+/g, " ").trim();
  }
  const alreadyInQbo = new Set<string>();
  for (const r of (existingRules || []) as Array<{ vendor_pattern: string | null; pushed_to_qbo: boolean | null }>) {
    if (r.pushed_to_qbo && r.vendor_pattern) {
      alreadyInQbo.add(normalizePattern(r.vendor_pattern));
    }
  }

  // Build proposed rules from EVERY vendor group. No vendor is dropped:
  //   - Vendors with an AI/bookkeeper target: pre-ticked, ready to create
  //   - Vendors with no target: shown with "Pick target…" dropdown,
  //     opt-in via tick + pick
  //   - Vendors already in QBO (from a prior export): shown with
  //     "Already in QBO" badge, default-unchecked. Re-ticking is safe —
  //     /api/rules/from-reclass upserts on (client_link_id, vendor_pattern)
  //     and the QBO push guard skips rows where pushed_to_qbo=true so we
  //     can't create a QBO duplicate.
  //
  // Sort order (top-down):
  //   1. Targeted + not in QBO yet  (the primary action)
  //   2. No target yet              (needs bookkeeper attention)
  //   3. Already in QBO              (reference / re-create if needed)
  const proposedRules = candidates
    .map((c) => ({
      vendorPattern: c.vendorPattern,
      vendorDisplay: c.vendorDisplay,
      targetAccountId: c.targetAccountId, // "" when no AI pick
      targetAccountName: c.targetAccountName, // "" when no AI pick
      txCount: c.txCount,
      totalAmount: c.totalAmount,
      hasTarget: c.hasTarget,
      alreadyInQbo: alreadyInQbo.has(normalizePattern(c.vendorPattern)),
      // Real bank descriptions this rule will match — the "show me the
      // transactions" preview (Mike, 2026-07-14). Was computed but dropped
      // here before reaching the page.
      sampleDescriptions: c.sampleDescriptions,
    }))
    .sort((a, b) => {
      // Group order: ready → needs target → already in QBO
      const rank = (r: typeof a) => (r.alreadyInQbo ? 2 : r.hasTarget ? 0 : 1);
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return b.txCount - a.txCount;
    });
  const ready = proposedRules.filter((r) => r.hasTarget && !r.alreadyInQbo).length;
  const needsTarget = proposedRules.filter((r) => !r.hasTarget && !r.alreadyInQbo).length;
  const inQbo = proposedRules.filter((r) => r.alreadyInQbo).length;
  console.log(
    `[bank-rules ${id}] Proposed: ${proposedRules.length} total — ${ready} ready, ${needsTarget} need target, ${inQbo} already in QBO`
  );

  // Build the FINAL dropdown list — MASTER COA ONLY. We deliberately do
  // NOT surface the client's raw/old QBO chart of accounts here: rule
  // targets must come from our curated master COA (post-cleanup), not the
  // legacy accounts we're migrating away from. The only non-master-name
  // entries allowed are targets the AI/bookkeeper actually used in THIS
  // job — kept solely so an already-selected row never blanks out (its
  // current value stays selectable). `otherActiveAccounts` is still
  // computed above for the diagnostic log but excluded from the dropdown.
  const dropdownById = new Map<
    string,
    { id: string; name: string; type: string; group: "master" | "other" }
  >();
  for (const a of availablePnLAccounts) {
    dropdownById.set(a.id, { ...a, group: "master" });
  }
  for (const rule of proposedRules) {
    if (!rule.targetAccountId) continue;
    if (dropdownById.has(rule.targetAccountId)) continue;
    dropdownById.set(rule.targetAccountId, {
      id: rule.targetAccountId,
      name: rule.targetAccountName,
      type: "(used in this job)",
      group: "master",
    });
  }
  const availableAccountsForDropdown = Array.from(dropdownById.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  console.log(
    `[bank-rules ${id}] Dropdown final: ${availableAccountsForDropdown.length} master-COA accounts (excluded ${otherActiveAccounts.length} legacy QBO accounts; ${availablePnLAccounts.length} master-matched + job targets)`
  );

  return (
    <AppShell>
      <TopBar
        title={`Bank Rules: ${clientName}`}
        subtitle="From Reclassification"
      />
      <WorkflowStepper
        currentStep="rules"
        currentState="active"
        completedSteps={["coa", "reclass"]}
        clientLinkId={job.client_link_id}
      />
      <div className="px-8 py-6 max-w-4xl">
        <BankRulesFromReclassClient
          reclassJobId={id}
          clientLinkId={job.client_link_id}
          clientName={clientName}
          proposedRules={proposedRules}
          excluded={excluded}
          availableAccounts={availableAccountsForDropdown}
          cleanupRangeStart={(job as any).date_range_start || null}
          cleanupRangeEnd={(job as any).date_range_end || null}
        />
      </div>
    </AppShell>
  );
}

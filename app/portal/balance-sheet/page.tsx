import { tryResolvePortalContext } from "@/lib/portal-context";
import { createServiceSupabase } from "@/lib/supabase";
import { fetchBalanceSheetSummary } from "@/lib/portal-data";
import { PortalErrorState } from "../error-state";
import { AskAboutButton } from "../ask-about";
import { StatementSwitcher } from "../financial-statements/statement-switcher";
import { StatementReviewNotes } from "../statement-review-notes";
import { Sparkles, MessageSquare, Wallet, CreditCard, PiggyBank } from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Live Balance Sheet, simplified "own / owe / yours" framing — facelifted to
 * match the portal visual system (gradient hero, teal AI-insight card,
 * accent-barred cards) and wired with the "Ask Ironbooks about this"
 * affordance on every line and on the whole-page summary.
 *
 * Strategy: pull the BS report at "today" + the accounts list, then bucket
 * accounts by Classification (Asset / Liability / Equity) and show the
 * largest items in each.
 */
export default async function BalanceSheetPage() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;
  const { ctx } = ctxResult;

  // BS toggle off = P&L-only service while the balance sheet cleanup
  // finishes. Showing the in-progress BS would mean showing numbers we
  // KNOW are wrong — friendly placeholder instead.
  const service = createServiceSupabase();
  const { data: clientRow } = await service
    .from("client_links")
    .select("*")
    .eq("id", ctx.clientLinkId)
    .single();
  // Show the BS only once a bookkeeper has explicitly pushed it to the portal
  // (bs_enabled = true). NULL / false → still hidden behind the placeholder, so
  // a client never sees an un-cleaned balance sheet before it's approved here.
  if ((clientRow as any)?.bs_enabled !== true) {
    return (
      <div className="max-w-2xl">
        <h1 className="text-2xl font-bold text-navy">Balance Sheet</h1>
        <div className="mt-6 bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
          <div className="inline-flex w-14 h-14 rounded-full bg-teal/10 items-center justify-center">
            <Sparkles size={24} className="text-teal" />
          </div>
          <h2 className="text-lg font-bold text-navy">
            We&apos;re still cleaning up your balance sheet
          </h2>
          <p className="text-sm text-ink-slate max-w-md mx-auto leading-relaxed">
            Your Profit &amp; Loss is live and up to date. &ldquo;Cleanup in
            progress&rdquo; means your bookkeeper is still verifying your
            account balances — bank accounts, loans, and equity — so the numbers
            are right before you see them. We&apos;d rather show you nothing than
            numbers that aren&apos;t right yet. We&apos;ll email you the moment
            it&apos;s ready.
          </p>
          <p className="text-xs text-ink-light">
            Want a status update?{" "}
            <a href="/portal/messages" className="font-semibold text-teal-dark hover:underline">
              Ask your bookkeeper on the Messages page
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  const bs = await fetchBalanceSheetSummary(ctx.qboRealmId, ctx.accessToken);

  // Group by classification, sort by abs(balance) desc, top N per group.
  const groups = {
    Asset: [] as { name: string; balance: number; account_id: string }[],
    Liability: [] as { name: string; balance: number; account_id: string }[],
    Equity: [] as { name: string; balance: number; account_id: string }[],
  };
  for (const acct of bs.accounts) {
    const bal = bs.balances.get(acct.Id) ?? 0;
    if (Math.abs(bal) < 0.01) continue;
    const g = acct.Classification as keyof typeof groups;
    if (g in groups) {
      groups[g].push({ name: acct.Name, balance: bal, account_id: acct.Id });
    }
  }
  for (const k of Object.keys(groups) as Array<keyof typeof groups>) {
    groups[k].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  }

  const netWorth = bs.totalAssets - bs.totalLiabilities;
  const asOfLabel = formatDate(bs.asOfDate);

  return (
    <div className="space-y-6">
      <StatementSwitcher active="bs" />
      {ctx.impersonating && (
        <StatementReviewNotes clientLinkId={ctx.clientLinkId} kind="bs" statementLabel="Balance Sheet" />
      )}

      {/* ── Gradient hero ───────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-teal/20 blur-2xl" />
        <div className="relative flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">Balance Sheet</div>
            <h1 className="text-3xl font-bold mt-1">What you own & what you owe</h1>
            <div className="text-sm text-white/70 mt-1">As of {asOfLabel} · a snapshot in time</div>
          </div>
          <div className="flex-shrink-0 bg-white/10 backdrop-blur rounded-xl px-5 py-3 border border-white/15">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-white/60">Net worth</div>
            <div className={`text-3xl font-bold mt-0.5 ${netWorth >= 0 ? "text-white" : "text-red-300"}`}>
              {netWorth < 0 ? `(${fmtMoney(Math.abs(netWorth))})` : fmtMoney(netWorth)}
            </div>
            <div className="text-xs text-white/70 mt-0.5">own minus owe</div>
          </div>
        </div>
      </div>

      {/* ── AI insight card ─────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border-2 border-teal/30 bg-gradient-to-br from-teal/10 via-white to-white p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-teal/15 flex items-center justify-center flex-shrink-0">
            <Sparkles size={18} className="text-teal-dark" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">In plain English</div>
            <p className="text-sm text-navy/85 leading-relaxed mt-1">
              If you sold everything today and paid off every debt, you'd have about{" "}
              <strong className={netWorth >= 0 ? "text-emerald-700" : "text-red-700"}>{fmtMoney(netWorth)}</strong>{" "}
              left over. That's your <strong>net worth</strong> as a business — built up from past
              profits, owner investments, and equity in your assets. You own{" "}
              <strong>{fmtMoney(bs.totalAssets)}</strong> and owe{" "}
              <strong>{fmtMoney(bs.totalLiabilities)}</strong>.
            </p>
            <div className="mt-3 flex items-center gap-3 flex-wrap">
              <a
                href="/portal/ask-ai"
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-dark hover:underline"
              >
                <MessageSquare size={12} /> Ask the AI about your balance sheet
              </a>
              <AskAboutButton
                kind="bs_summary"
                label="Balance sheet summary"
                period={`As of ${asOfLabel}`}
                context={{
                  total_assets: bs.totalAssets,
                  total_liabilities: bs.totalLiabilities,
                  net_worth: netWorth,
                  as_of: bs.asOfDate,
                }}
                subtitle="We'll review your balance sheet and reply by email."
                variant="chip"
              />
            </div>
          </div>
        </div>
      </div>

      {/* ── Own / Owe / Yours ───────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card
          title="What you own"
          subtitle='"Assets"'
          icon={Wallet}
          amount={fmtMoney(bs.totalAssets)}
          tone="emerald"
          rows={groups.Asset}
          asOfLabel={asOfLabel}
          group="Assets"
        />
        <Card
          title="What you owe"
          subtitle='"Liabilities"'
          icon={CreditCard}
          amount={fmtMoney(bs.totalLiabilities)}
          tone="amber"
          rows={groups.Liability}
          asOfLabel={asOfLabel}
          group="Liabilities"
        />
        <Card
          title="What's yours"
          subtitle='"Equity" — own minus owe'
          icon={PiggyBank}
          amount={fmtMoney(netWorth)}
          tone="teal"
          rows={groups.Equity}
          asOfLabel={asOfLabel}
          group="Equity"
          emphasize
        />
      </div>

      {/* ── Balance equation ────────────────────────────────────────── */}
      <div className="rounded-2xl bg-gradient-to-r from-slate-50 to-white border border-slate-200 p-5 text-center text-sm text-ink-slate">
        <strong className="text-navy">{fmtMoney(bs.totalAssets)}</strong> (you own) −{" "}
        <strong className="text-navy">{fmtMoney(bs.totalLiabilities)}</strong> (you owe) ={" "}
        <strong className="text-teal-dark">{fmtMoney(netWorth)}</strong> (yours) ✓
        <div className="text-xs text-ink-light mt-1">
          That's why it's called a "balance" sheet — these always equal out.
        </div>
      </div>
    </div>
  );
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  return sign + abs.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function Card({
  title, subtitle, icon: Icon, amount, tone, rows, emphasize, asOfLabel, group,
}: {
  title: string; subtitle: string; icon: any; amount: string;
  tone: "emerald" | "amber" | "teal";
  rows: { name: string; balance: number; account_id: string }[];
  emphasize?: boolean;
  asOfLabel: string;
  group: string;
}) {
  const toneColors = {
    emerald: "text-emerald-700",
    amber: "text-amber-700",
    teal: "text-teal-dark",
  }[tone];
  const accentBar = {
    emerald: "bg-emerald-500",
    amber: "bg-amber-400",
    teal: "bg-teal",
  }[tone];
  const iconChip = {
    emerald: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    teal: "bg-teal/10 text-teal-dark",
  }[tone];
  const borderClass = emphasize ? "border-2 border-teal/40" : "border border-slate-200";
  return (
    <div className={`relative bg-white ${borderClass} rounded-2xl p-5 overflow-hidden`}>
      <span className={`absolute left-0 top-0 h-full w-1 ${accentBar}`} />
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${iconChip}`}>
          <Icon size={14} />
        </span>
        <div className={`text-xs ${emphasize ? "text-teal-dark" : "text-ink-slate"} uppercase tracking-wider font-semibold`}>
          {title}
        </div>
      </div>
      <div className={`text-2xl font-bold ${toneColors} mt-1`}>{amount}</div>
      <div className="text-xs text-ink-slate mt-1">{subtitle}</div>
      <div className="mt-4 space-y-1 text-sm">
        {rows.length === 0 ? (
          <div className="text-xs text-ink-light italic">No items.</div>
        ) : (
          rows.slice(0, 8).map((r, i) => (
            <div key={i} className="flex items-center justify-between gap-2 py-1 group">
              <span className="text-ink-slate truncate" title={r.name}>{r.name}</span>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="font-mono text-sm text-navy">{fmtMoney(r.balance)}</span>
                <AskAboutButton
                  kind="bs_line"
                  label={r.name}
                  amount={r.balance}
                  period={`As of ${asOfLabel}`}
                  context={{ section: group, account_id: r.account_id }}
                  variant="icon"
                />
              </div>
            </div>
          ))
        )}
        {rows.length > 8 && (
          <div className="text-[11px] text-ink-light italic">+ {rows.length - 8} smaller items</div>
        )}
      </div>
    </div>
  );
}

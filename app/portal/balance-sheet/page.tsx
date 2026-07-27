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
        <div className="mt-6 bg-white border border-cardline rounded-2xl p-8 text-center space-y-3">
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

      {/* ── Header — quiet, light; no dark hero ─────────────────────── */}
      <header className="min-w-0">
        <div className="font-brand text-[11px] uppercase tracking-[0.14em] text-teal-dark">Balance Sheet</div>
        <h1 className="font-brand text-3xl font-semibold text-navy leading-none mt-1.5">What you own &amp; what you owe</h1>
        <div className="text-sm text-ink-slate mt-2">As of {asOfLabel} · a snapshot in time</div>
      </header>

      {/* ── Assets − Liabilities = Net worth, one connected strip ───── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 rounded-2xl border border-cardline bg-white overflow-hidden">
        {[
          { label: "What you own", note: "Assets", value: bs.totalAssets, op: "", net: false, neg: false },
          { label: "What you owe", note: "Liabilities", value: bs.totalLiabilities, op: "−", net: false, neg: true },
          { label: "What's yours", note: "Net worth · own − owe", value: netWorth, op: "=", net: true, neg: netWorth < 0 },
        ].map((s, i) => (
          <div key={s.label} className={`relative px-5 py-4 border-t border-hairline sm:border-t-0 sm:border-l first:border-l-0 ${s.net ? "bg-teal-lighter" : ""}`}>
            {s.op && (
              <span className="hidden sm:flex absolute -left-[9px] top-1/2 -translate-y-1/2 w-[18px] h-[18px] items-center justify-center rounded-full bg-canvas border border-cardline text-ink-light text-[11px] font-bold z-10">{s.op}</span>
            )}
            <div className={`font-brand text-[10px] uppercase tracking-[0.1em] ${s.net ? "text-teal-dark" : "text-ink-light"}`}>{s.label}</div>
            <div className={`text-[22px] font-bold mt-2 tabular-nums leading-none ${s.net ? "text-teal-dark" : s.neg ? "text-rust" : "text-navy"}`}>{fmtMoney(s.value)}</div>
            <div className="text-[11.5px] text-ink-slate mt-1.5">{s.note}</div>
          </div>
        ))}
      </div>

      {/* ── AI insight card ─────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-teal-border bg-teal-lighter p-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full bg-teal/15 flex items-center justify-center flex-shrink-0">
            <Sparkles size={18} className="text-teal-dark" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-bold text-teal-dark uppercase tracking-wider">In plain English</div>
            <p className="text-sm text-navy/85 leading-relaxed mt-1">
              If you sold everything today and paid off every debt, you'd have about{" "}
              <strong className={netWorth >= 0 ? "text-emerald-700" : "text-rust"}>{fmtMoney(netWorth)}</strong>{" "}
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

      <p className="text-[11.5px] text-ink-light leading-relaxed px-1">
        A snapshot as of {asOfLabel}. What you own always equals what you owe plus what&apos;s yours —
        that&apos;s why it&apos;s called a &ldquo;balance&rdquo; sheet.
      </p>
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
    emerald: "text-teal-dark",
    amber: "text-gold-deep",
    teal: "text-teal-dark",
  }[tone];
  const iconChip = {
    emerald: "bg-teal/10 text-teal-dark",
    amber: "bg-gold-tint text-gold-deep",
    teal: "bg-teal/10 text-teal-dark",
  }[tone];
  return (
    <div className={`relative bg-white rounded-2xl p-5 overflow-hidden ${emphasize ? "border border-teal-border bg-teal-lighter" : "border border-cardline"}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${iconChip}`}>
          <Icon size={14} />
        </span>
        <div className={`font-brand text-[11px] ${emphasize ? "text-teal-dark" : "text-ink-slate"} uppercase tracking-[0.1em]`}>
          {title}
        </div>
      </div>
      <div className={`text-2xl font-bold ${toneColors} mt-2 tabular-nums`}>{amount}</div>
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

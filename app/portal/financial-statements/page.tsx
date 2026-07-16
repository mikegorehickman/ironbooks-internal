import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { tryResolvePortalContext } from "@/lib/portal-context";
import { PortalErrorState } from "../error-state";
import { DraftStageBanner } from "../draft-stage-banner";
import { STATEMENTS } from "./statement-switcher";

export const dynamic = "force-dynamic";

/**
 * /portal/financial-statements — hub the "Financial Statements" nav item
 * lands on. Three big tiles (P&L / Balance Sheet / Cash Flow) so the side
 * nav stays compact while all three statements remain one click away.
 */
export default async function FinancialStatementsHub() {
  const ctxResult = await tryResolvePortalContext();
  if (!ctxResult.ok) return <PortalErrorState code={ctxResult.code} message={ctxResult.message} />;

  return (
    <div className="space-y-6">
      <DraftStageBanner clientLinkId={ctxResult.ctx.clientLinkId} />
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-navy via-navy to-teal-dark px-6 py-6 text-white">
        <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full bg-teal/20 blur-2xl" />
        <div className="relative">
          <div className="text-xs text-white/60 uppercase tracking-wider font-semibold">
            Financial Statements
          </div>
          <h1 className="text-3xl font-bold mt-1">Your three core reports</h1>
          <div className="text-sm text-white/70 mt-1">
            Profit tells you if the business model works. The balance sheet tells
            you what it's worth. Cash flow tells you if you can make payroll.
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {STATEMENTS.map((s) => {
          const Icon = s.icon;
          return (
            <Link
              key={s.id}
              href={s.href}
              className="group bg-white rounded-2xl border border-gray-200 p-6 hover:border-teal hover:shadow-md transition-all flex flex-col"
            >
              <div className="w-12 h-12 rounded-xl bg-teal-lighter flex items-center justify-center mb-4">
                <Icon size={22} className="text-teal" />
              </div>
              <div className="text-lg font-bold text-navy">{s.label}</div>
              <p className="text-sm text-ink-slate mt-1 leading-relaxed flex-1">
                {s.id === "pnl" &&
                  "Income, expenses, and what's left over — month by month or any period you pick."}
                {s.id === "bs" &&
                  "A snapshot of what you own, what you owe, and your net worth as a business."}
                {s.id === "cfs" &&
                  "Where cash actually came from and went — operations, investments, and financing."}
              </p>
              <div className="flex items-center gap-1.5 text-sm font-semibold text-teal mt-4 group-hover:gap-2.5 transition-all">
                Open <ArrowRight size={14} />
              </div>
            </Link>
          );
        })}
      </div>

      <p className="text-xs text-ink-slate/70 text-center max-w-lg mx-auto">
        All three statements are pulled live from your QuickBooks data. Questions
        about a number? Use the "Ask Ironbooks" button on any statement.
      </p>
    </div>
  );
}

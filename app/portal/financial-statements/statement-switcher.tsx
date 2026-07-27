import Link from "next/link";
import { FileText, Scale, Waves } from "lucide-react";

/**
 * The three-tile statement switcher shown at the top of every financial
 * statement page (and, in large form, on the /portal/financial-statements
 * hub). Lets clients hop between P&L / Balance Sheet / Cash Flow without
 * going back to the side nav.
 */
export const STATEMENTS = [
  {
    id: "pnl" as const,
    href: "/portal/profit-loss",
    label: "Profit & Loss",
    blurb: "What you earned and spent",
    icon: FileText,
  },
  {
    id: "bs" as const,
    href: "/portal/balance-sheet",
    label: "Balance Sheet",
    blurb: "What you own and owe",
    icon: Scale,
  },
  {
    id: "cfs" as const,
    href: "/portal/cash-flow",
    label: "Cash Flow",
    blurb: "Where your cash actually went",
    icon: Waves,
  },
];

export type StatementId = (typeof STATEMENTS)[number]["id"];

export function StatementSwitcher({ active }: { active: StatementId }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {STATEMENTS.map((s) => {
        const isActive = s.id === active;
        const Icon = s.icon;
        return (
          <Link
            key={s.id}
            href={s.href}
            aria-current={isActive ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-xl border px-3.5 py-2.5 transition-colors ${
              isActive
                ? "bg-navy border-navy text-white"
                : "bg-white border-cardline text-navy hover:border-teal"
            }`}
          >
            <Icon size={16} className={isActive ? "text-teal-light" : "text-teal"} />
            <div className="min-w-0">
              <div className="text-sm font-bold leading-tight truncate">{s.label}</div>
              <div
                className={`text-[11px] leading-tight truncate hidden md:block ${
                  isActive ? "text-white/60" : "text-ink-slate"
                }`}
              >
                {s.blurb}
              </div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

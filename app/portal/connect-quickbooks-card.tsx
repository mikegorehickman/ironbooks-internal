import { Link2, CheckCircle2 } from "lucide-react";

/**
 * Portal onboarding card: how the client adds IronBooks as their accountant in
 * QuickBooks. Shown on the portal home while QBO isn't connected yet, so a
 * client can get us access BEFORE their onboarding call (we also cover it live
 * on the call as the fallback).
 *
 * The firm's Intuit accountant email comes from NEXT_PUBLIC_QBO_ACCOUNTANT_EMAIL;
 * until that's set we point them at the email in their welcome message rather
 * than show a guessed address. Screenshot slots are captioned placeholders —
 * drop real QBO screenshots into /public/qbo-help and swap the <Placeholder>
 * boxes for <img> when you have them.
 */
const ACCOUNTANT_EMAIL = process.env.NEXT_PUBLIC_QBO_ACCOUNTANT_EMAIL || "";

function Placeholder({ caption }: { caption: string }) {
  return (
    <div className="rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-3 py-6 text-center">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Screenshot</div>
      <div className="text-xs text-slate-500 mt-1">{caption}</div>
    </div>
  );
}

const STEPS: { title: string; body: React.ReactNode; shot: string }[] = [
  {
    title: "Open Manage Users in QuickBooks",
    body: <>In QuickBooks Online, click the <strong>⚙ gear icon</strong> (top-right) → under <strong>Your Company</strong> choose <strong>Manage users</strong>.</>,
    shot: "Settings gear → Manage users",
  },
  {
    title: "Go to the Accountants tab",
    body: <>Select the <strong>Accountants</strong> (or <strong>Accounting firms</strong>) tab.</>,
    shot: "Accountants tab",
  },
  {
    title: "Invite IronBooks",
    body: ACCOUNTANT_EMAIL
      ? <>Enter <strong>{ACCOUNTANT_EMAIL}</strong> and click <strong>Invite</strong>.</>
      : <>Enter the IronBooks accountant email from your welcome message and click <strong>Invite</strong>.</>,
    shot: "Enter email → Invite",
  },
  {
    title: "That's it",
    body: <>We'll accept the invite and finish connecting your books — nothing more needed from you.</>,
    shot: "Invitation sent",
  },
];

export function ConnectQuickBooksCard() {
  return (
    <section className="rounded-2xl border-2 border-teal/20 bg-gradient-to-br from-teal/5 to-white p-6">
      <div className="flex items-start gap-3">
        <div className="p-2 rounded-lg bg-teal/10 flex-shrink-0">
          <Link2 size={20} className="text-teal" />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-navy">Connect us to your QuickBooks</h2>
          <p className="text-sm text-ink-slate mt-1 leading-relaxed">
            To get started we need access to your books. It takes about a minute — add IronBooks as your accountant in QuickBooks. We'll also walk you through this on your onboarding call, but doing it now lets us start sooner.
          </p>
        </div>
      </div>

      <ol className="mt-5 grid gap-4 sm:grid-cols-2">
        {STEPS.map((s, i) => (
          <li key={i} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex items-center gap-2">
              <span className="inline-flex w-6 h-6 rounded-full bg-teal text-white text-xs font-bold items-center justify-center flex-shrink-0">{i + 1}</span>
              <span className="font-semibold text-navy text-sm">{s.title}</span>
            </div>
            <p className="text-sm text-ink-slate mt-2 leading-relaxed">{s.body}</p>
            <div className="mt-3">
              <Placeholder caption={s.shot} />
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-4 flex items-start gap-2 rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-2.5">
        <CheckCircle2 size={16} className="text-emerald-600 flex-shrink-0 mt-0.5" />
        <p className="text-sm text-emerald-900">
          Once you've sent the invite, you're done — this card will disappear automatically when we're connected.
        </p>
      </div>
    </section>
  );
}

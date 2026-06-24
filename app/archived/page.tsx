import { AppShell } from "@/components/AppShell";
import { TopBar } from "@/components/TopBar";
import { Archive } from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * /archived — the notice a V2 user sees when they land on a tool that was
 * retired in the site simplification (unused in the 30-day usage audit). The
 * route and its data are untouched — this is "hide", not "delete". An admin
 * can re-enable a tool by adding it back to the nav / removing it from
 * ARCHIVED_TOOL_PATTERNS in lib/feature-flags.ts.
 *
 * Reached via a middleware rewrite, so the original URL stays in the address
 * bar; `?from=` carries the path we intercepted for a friendlier label.
 */
const TOOL_NAMES: { match: string; name: string }[] = [
  { match: "uf-audit", name: "UF Audit" },
  { match: "uf-ai", name: "UF AI Reconcile" },
  { match: "uf-ar", name: "UF A/R Reconcile" },
  { match: "ar-recovery", name: "A/R Recovery" },
  { match: "uncat-income-recovery", name: "Uncategorized Income Recovery" },
  { match: "hardcore-cleanup", name: "Hardcore BS Cleanup" },
  { match: "tax-audit", name: "GST/HST Audit" },
  { match: "month-end", name: "Month-End (legacy)" },
  { match: "support", name: "Support tickets" },
];

function toolName(from: string): string {
  return TOOL_NAMES.find((t) => from.includes(t.match))?.name || "This tool";
}

export default async function ArchivedPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const { from = "" } = await searchParams;
  const name = toolName(from);

  return (
    <AppShell>
      <TopBar title="Archived tool" subtitle="Retired in the SNAP cleanup" />
      <div className="max-w-xl mx-auto mt-16 text-center">
        <div className="inline-flex p-3 rounded-2xl bg-gray-100 text-ink-slate mb-4">
          <Archive size={28} />
        </div>
        <h2 className="text-lg font-bold text-navy">{name} has been archived</h2>
        <p className="text-sm text-ink-slate mt-2 leading-relaxed">
          This tool wasn&apos;t used in the last 30 days, so it&apos;s hidden to keep the
          app focused. Nothing was deleted — its data is intact and an admin can
          re-enable it if it&apos;s needed again.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2">
          <Link
            href="/workflow"
            className="text-sm font-semibold bg-teal text-white px-4 py-2 rounded-lg hover:bg-teal-dark"
          >
            Go to Workflow
          </Link>
          <Link
            href="/clients"
            className="text-sm font-semibold text-ink-slate px-4 py-2 rounded-lg hover:bg-gray-100"
          >
            Clients
          </Link>
        </div>
      </div>
    </AppShell>
  );
}

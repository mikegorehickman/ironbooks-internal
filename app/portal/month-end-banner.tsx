"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, FileCheck2 } from "lucide-react";

export function MonthEndBanner() {
  const [banner, setBanner] = useState<{
    packageId: string;
    label: string;
    periodYear: number;
    periodMonth: number;
  } | null>(null);

  useEffect(() => {
    fetch("/api/portal/month-end-banner")
      .then((r) => r.json())
      .then((d) => setBanner(d.banner || null))
      .catch(() => {});
  }, []);

  if (!banner) return null;

  async function dismiss() {
    await fetch("/api/portal/month-end-banner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package_id: banner!.packageId }),
    });
    setBanner(null);
  }

  const href = `/portal/statements/${banner.periodYear}/${banner.periodMonth}`;

  return (
    <div className="mb-6 flex items-center gap-3 rounded-xl border border-teal-border bg-teal-light px-4 py-3">
      <FileCheck2 size={20} className="text-teal-dark flex-shrink-0" />
      <p className="text-sm text-navy flex-1">
        Your <strong>{banner.label}</strong> statements are ready.{" "}
        <Link href={href} className="font-semibold text-teal-dark hover:underline">
          View now
        </Link>
      </p>
      <button
        type="button"
        onClick={dismiss}
        className="text-ink-slate hover:text-navy p-1"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
    </div>
  );
}

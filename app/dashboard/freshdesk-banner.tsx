"use client";

import { useEffect, useState } from "react";
import { LifeBuoy, ExternalLink, X } from "lucide-react";

/**
 * Dashboard banner: "You have N unread support tickets" → Freshdesk.
 *
 * "Unread" = tickets whose last message is from the customer (new tickets +
 * customer replies with no agent reply after) — see /api/freshdesk/unread.
 *
 * Renders NOTHING unless count > 0, and fails silently on any error so the
 * dashboard never depends on Freshdesk being up. Fetched client-side after
 * page load so it can't slow the dashboard down. Dismiss hides it for this
 * page view only — it returns while tickets are still unanswered (that's the
 * point of the banner).
 */
export function FreshdeskBanner() {
  const [count, setCount] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/freshdesk/unread")
      .then((r) => (r.ok ? r.json() : { count: 0 }))
      .then((b) => {
        if (alive && typeof b?.count === "number") setCount(b.count);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (dismissed || count <= 0) return null;

  return (
    <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
      <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center flex-shrink-0">
        <LifeBuoy size={18} />
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-sm font-semibold text-navy">
          You have {count} unread support ticket{count === 1 ? "" : "s"}
        </span>
        <span className="text-sm text-ink-slate">
          {" "}— new tickets or customer replies waiting for a response.
        </span>
      </div>
      <a
        href="https://ironbooks.freshdesk.com/a/tickets"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-800 hover:text-amber-900 border border-amber-300 hover:border-amber-400 bg-white px-3 py-1.5 rounded-lg whitespace-nowrap"
      >
        Open Freshdesk
        <ExternalLink size={13} />
      </a>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-700/60 hover:text-amber-800 p-1"
        title="Hide for now"
      >
        <X size={15} />
      </button>
    </div>
  );
}

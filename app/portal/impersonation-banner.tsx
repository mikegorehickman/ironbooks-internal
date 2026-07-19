"use client";

import { useRouter } from "next/navigation";
import { Eye, LogOut, Loader2, ChevronDown } from "lucide-react";
import { useState } from "react";

/**
 * Sticky banner shown across the top of the portal whenever an admin is
 * impersonating a client. Designed to be unmissable — bright amber + an
 * explicit "Stop impersonating" button. Server-rendered by the portal
 * layout based on ctx.impersonating.
 *
 * The client dropdown lets a senior hop straight to any other client with an
 * active portal user (re-runs impersonate/start with that client_link_id) —
 * no round-trip through the clients list.
 */
export function ImpersonationBanner({
  clientName,
  clientUserName,
  realUserName,
  currentClientLinkId,
  portalClients = [],
}: {
  clientName: string;
  clientUserName: string;
  realUserName: string;
  currentClientLinkId?: string;
  portalClients?: Array<{ client_link_id: string; name: string }>;
}) {
  const router = useRouter();
  const [stopping, setStopping] = useState(false);
  const [switching, setSwitching] = useState(false);

  async function stop() {
    setStopping(true);
    try {
      const res = await fetch("/api/admin/impersonate/stop", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      router.push(body.redirect || "/admin/invite-client");
      // Force a full reload so the banner disappears and middleware re-evaluates
      router.refresh();
    } catch {
      setStopping(false);
    }
  }

  async function switchTo(clientLinkId: string) {
    if (!clientLinkId || clientLinkId === currentClientLinkId || switching) return;
    setSwitching(true);
    try {
      const res = await fetch("/api/admin/impersonate/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_link_id: clientLinkId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(body.error || "Couldn't switch to that client.");
        setSwitching(false);
        return;
      }
      // New impersonation cookie is set — land on the portal home and reload.
      router.push(body.redirect || "/portal");
      router.refresh();
    } catch {
      setSwitching(false);
    }
  }

  return (
    <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between text-sm gap-3">
      <div className="flex items-center gap-2 min-w-0">
        <Eye size={14} className="flex-shrink-0" />
        <span className="truncate">
          <strong>Impersonating</strong> {clientUserName || "client user"} at{" "}
          <strong>{clientName}</strong>
          <span className="opacity-75 ml-2 hidden sm:inline">· You are signed in as {realUserName}</span>
        </span>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {portalClients.length > 1 && (
          <div className="relative inline-flex items-center">
            <select
              value={currentClientLinkId || ""}
              disabled={switching}
              onChange={(e) => switchTo(e.target.value)}
              className="appearance-none bg-white text-amber-800 font-bold text-xs rounded pl-2.5 pr-7 py-1 max-w-[180px] sm:max-w-[240px] truncate disabled:opacity-60 cursor-pointer focus:outline-none focus:ring-2 focus:ring-white/60"
              title="Switch to another client's portal"
            >
              {!currentClientLinkId && <option value="">Switch client…</option>}
              {portalClients.map((c) => (
                <option key={c.client_link_id} value={c.client_link_id}>{c.name}</option>
              ))}
            </select>
            <span className="pointer-events-none absolute right-1.5 text-amber-700">
              {switching ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={13} />}
            </span>
          </div>
        )}
        <button
          onClick={stop}
          disabled={stopping}
          className="inline-flex items-center gap-1 bg-white text-amber-700 hover:bg-amber-50 disabled:opacity-50 px-3 py-1 rounded text-xs font-bold"
        >
          {stopping ? <Loader2 size={11} className="animate-spin" /> : <LogOut size={11} />}
          <span className="hidden sm:inline">Stop impersonating</span>
          <span className="sm:hidden">Stop</span>
        </button>
      </div>
    </div>
  );
}

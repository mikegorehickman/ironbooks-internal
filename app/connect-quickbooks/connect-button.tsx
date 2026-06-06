"use client";

import { useState } from "react";

/**
 * The official "Connect to QuickBooks" CTA. Pure client component so we
 * can show a loading state while Intuit's OAuth page is loading — without
 * it, users sometimes double-click and trigger the CSRF state mismatch.
 *
 * Visually approximates Intuit's recommended button colors so review staff
 * recognize it as a standard QBO connect surface.
 */
export function ConnectButton({ href }: { href: string }) {
  const [loading, setLoading] = useState(false);

  return (
    <a
      href={href}
      onClick={() => setLoading(true)}
      aria-disabled={loading}
      className={`block w-full text-center px-5 py-3 rounded-lg text-sm font-bold transition-all shadow-sm ${
        loading
          ? "bg-[#1F7D14] text-white/80 cursor-wait"
          : "bg-[#2CA01C] hover:bg-[#1F7D14] text-white"
      }`}
    >
      {loading ? "Redirecting to Intuit..." : "Connect to QuickBooks"}
    </a>
  );
}

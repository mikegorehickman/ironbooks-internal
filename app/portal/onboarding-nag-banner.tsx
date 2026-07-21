"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Sparkles, ArrowRight } from "lucide-react";

/**
 * Persistent "finish setup" strip shown across the portal until the new client
 * completes the required onboarding steps (form + documents). Hides itself on
 * the wizard page. Server layout decides WHETHER to render it; this only
 * handles the path-based self-hide.
 */
export function OnboardingNagBanner() {
  const pathname = usePathname();
  if (pathname?.startsWith("/portal/onboarding")) return null;
  return (
    <Link
      href="/portal/onboarding"
      className="block bg-teal text-white px-4 py-2 text-sm hover:bg-teal-dark transition-colors"
    >
      <span className="max-w-5xl mx-auto flex items-center gap-2">
        <Sparkles size={14} className="flex-shrink-0" />
        <span className="flex-1"><strong>Finish setting up your account</strong> — a couple of quick steps so we can get your books right.</span>
        <span className="inline-flex items-center gap-1 font-semibold whitespace-nowrap">Continue <ArrowRight size={13} /></span>
      </span>
    </Link>
  );
}

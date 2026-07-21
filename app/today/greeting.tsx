"use client";

import { useEffect, useState } from "react";

/**
 * Time-of-day greeting for the Home screen — "Good morning, Lisa". Computed
 * CLIENT-side on purpose: the server renders in UTC on Vercel, so a
 * server-side greeting would say "Good evening" at 9am half the year. Renders
 * the neutral fallback until mounted so hydration always matches.
 */
export function Greeting({ name, fallback = "Today" }: { name: string; fallback?: string }) {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    const h = new Date().getHours();
    const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    setText(name ? `${part}, ${name}` : part);
  }, [name]);

  return <>{text ?? fallback}</>;
}

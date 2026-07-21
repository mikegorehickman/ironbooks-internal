"use client";

import { createContext, useContext } from "react";
import { Sidebar } from "@/components/Sidebar";

/**
 * True once we're already inside an AppShell. Lets us compose existing
 * full-page surfaces (each of which wraps itself in <AppShell>) inside a
 * unified hub page (Home, Oversight) without double-rendering the sidebar
 * chrome: the outer AppShell paints the shell and marks the subtree nested;
 * any inner AppShell then renders its children bare.
 */
const AppShellNesting = createContext(false);

export function AppShell({ children }: { children: React.ReactNode }) {
  const nested = useContext(AppShellNesting);
  if (nested) {
    // Already inside a shell (composed into a hub page) — render content only.
    return <>{children}</>;
  }
  return (
    <AppShellNesting.Provider value={true}>
      <div className="flex min-h-screen bg-[var(--app-canvas)]">
        <Sidebar />
        <main className="flex-1 overflow-x-hidden">{children}</main>
      </div>
    </AppShellNesting.Provider>
  );
}

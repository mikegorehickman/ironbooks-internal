import type { Metadata } from "next";
import "./globals.css";
import { TimeTrackerProvider } from "@/components/time-tracker/TimeTrackerProvider";

export const metadata: Metadata = {
  title: "Ironbooks SNAP",
  description: "Financial clarity built for trades. Bookkeeper operating system for painting contractors.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Figtree:wght@300;400;500;600;700;800;900&family=Oswald:wght@500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans antialiased bg-[var(--app-canvas)] text-navy">
        {children}
        {/* Bookkeeper time tracker. Mounted here because this is the only node
            that survives every navigation — AppShell renders per page, so a
            timer inside it would remount (and reset) on each route change. It
            self-gates: portal/public paths and non-bookkeeping roles render
            nothing. Keep the layout static — the provider is a client
            component and fetches its own role. */}
        <TimeTrackerProvider />
      </body>
    </html>
  );
}

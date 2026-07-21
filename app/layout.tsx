import type { Metadata } from "next";
import "./globals.css";

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
      </body>
    </html>
  );
}

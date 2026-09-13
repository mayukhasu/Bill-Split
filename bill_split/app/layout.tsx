import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "MoneySplit",
  description: "MoneySplit — split bills simply",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-brand-bg text-brand-text">
        <header className="w-full border-b-2 border-brand-border" style={{ backgroundColor: "#13110E" }}>
          <div className="mx-auto max-w-5xl px-6 py-4 flex items-center gap-3">
            <Link href="/" className="text-xl font-bold" style={{ color: "#F1E4E6" }}>
              MoneySplit
            </Link>
            <span
              className="text-[0.65rem] font-bold uppercase tracking-widest rounded-full px-2 py-0.5"
              style={{ color: "#0D0B02", backgroundColor: "#6C720C" }}
            >
              beta
            </span>
          </div>
        </header>

        <main className="flex-1 w-full">
          <div className="mx-auto max-w-5xl px-6 py-10">{children}</div>
        </main>

        <footer className="w-full border-t border-brand-border">
          <div className="mx-auto max-w-5xl px-6 py-4 text-sm text-brand-muted">
            © 2026 MoneySplit
          </div>
        </footer>
      </body>
    </html>
  );
}

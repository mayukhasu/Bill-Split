import type { Metadata } from "next";
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
        <header className="w-full border-b-2 border-brand-border" style={{ backgroundColor: "#713600" }}>
          <div className="mx-auto max-w-5xl px-6 py-4 flex items-center gap-3">
            <span className="text-xl font-bold" style={{ color: "#FDFBD4" }}>
              MoneySplit
            </span>
            <span
              className="text-[0.65rem] font-bold uppercase tracking-widest rounded-full px-2 py-0.5"
              style={{ color: "#FDFBD4", backgroundColor: "#C05800" }}
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

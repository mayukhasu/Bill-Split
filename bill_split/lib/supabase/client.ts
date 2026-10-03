import { createBrowserClient } from "@supabase/ssr";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env.local (see .env.local.example) — this is a NEXT_PUBLIC_* var, so it must also be set in Vercel's project settings before building for production.`
    );
  }
  return value;
}

// Browser-side Supabase client. Not used by anything in the Phase 0/1 UI yet (every
// interactive piece so far is a Server Action/Component), but kept as the canonical entry
// point for any future Client Component that needs live client-side auth state.
export function getSupabaseBrowserClient() {
  return createBrowserClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
  );
}

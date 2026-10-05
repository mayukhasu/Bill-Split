import { createBrowserClient } from "@supabase/ssr";

// NEXT_PUBLIC_* vars only get inlined into the browser bundle when webpack can see the
// literal `process.env.NEXT_PUBLIC_X` expression directly in the source at build time — a
// dynamic `process.env[name]` lookup (name as a variable) can't be statically analyzed, so
// nothing gets substituted and the value is just undefined in the browser, no matter what's
// actually in .env.local. These have to be read as literal property accesses, not through a
// shared helper function, which is why this isn't factored like requireEnv in server.ts
// (where process.env is a real, fully-populated runtime object either way).
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

// Browser-side Supabase client — used by ScanReceiptClient.tsx to upload a receipt image
// directly to Storage from the browser (the only client-side Supabase call in the app; the
// RLS policies on storage.objects are what keep this safe without a service-role key).
export function getSupabaseBrowserClient() {
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Set them in .env.local (see .env.local.example) — these are NEXT_PUBLIC_* vars, so they must also be set in Vercel's project settings before building for production."
    );
  }
  return createBrowserClient(supabaseUrl, supabasePublishableKey);
}

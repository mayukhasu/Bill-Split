import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env.local (see .env.local.example) — this is a NEXT_PUBLIC_* var, so it must also be set in Vercel's project settings before building for production.`
    );
  }
  return value;
}

// Server-side Supabase client for Server Components, Server Actions, and Route Handlers.
// Deliberately NOT a module-level singleton — it's bound to one request's cookie jar via
// `cookies()`, so a fresh client must be built on every call (cookies() is async in this
// Next.js version, confirmed from node_modules/next/dist/docs).
export async function getSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          // In a Server Component (not a Server Action/Route Handler), calling
          // cookieStore.set() throws — there's no response to attach the cookie to.
          // Session refresh for that case is handled separately by proxy.ts, so this is
          // safe to swallow here rather than crash page rendering.
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Expected when called from a Server Component — see comment above.
          }
        },
      },
    }
  );
}

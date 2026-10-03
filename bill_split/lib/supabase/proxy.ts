import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Set it in .env.local (see .env.local.example).`);
  }
  return value;
}

// This is session-cookie refresh ONLY — it is NOT the app's security boundary, and it never
// requires login or blocks a request. Next's own docs warn that a Proxy matcher excluding a
// path also skips Server Function calls on that path, so auth is verified independently
// inside each protected Server Function/Component instead (see the per-page checks in
// app/(account)/expenses/*). The real enforcement is Postgres RLS: even if a page-level
// check were ever missed, RLS still prevents cross-user data access.
//
// The root proxy.ts matcher only routes /login, /auth/*, and /expenses/* through this file
// at all — the bill-split pages never invoke it, structurally, not by a runtime check here.
// Every path that *does* reach this function genuinely requires Supabase, so throwing on a
// missing env var (same as lib/supabase/server.ts and client.ts) is correct here too.
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getUser() (not the newer getClaims()) — correctness over a marginal latency win at
  // this traffic scale; getClaims() only pays off with asymmetric JWT signing keys enabled,
  // which this project doesn't assume.
  await supabase.auth.getUser();

  return response;
}

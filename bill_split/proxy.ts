import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Named `proxy.ts` (not `middleware.ts`) and exporting `proxy` (not `middleware`) — this
// Next.js version renamed the file convention. Confirmed directly from
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Allowlist, not a denylist: only the account/auth/expenses routes ever invoke this file.
  // The bill-split pages (/, /review) are never matched here at all — not "happens to no-op,"
  // structurally excluded. This also means bill-split pages never cost a Supabase round trip.
  // Add a new prefix here only when adding a new route under app/(account)/ that needs a
  // refreshed session (e.g. a future /expenses/bank-import).
  matcher: ["/login", "/auth/:path*", "/expenses/:path*"],
};

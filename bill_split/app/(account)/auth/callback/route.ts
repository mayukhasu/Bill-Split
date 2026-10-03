import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Google/Supabase redirect the browser here after consent, with ?code=... to exchange for a
// session. This has to be a Route Handler (an addressable URL) rather than a Server Action —
// it's an external redirect target, not something the app invokes itself.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/expenses";
  const oauthError = searchParams.get("error_description") ?? searchParams.get("error");

  if (oauthError) {
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(oauthError)}`);
  }

  if (code) {
    const supabase = await getSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("Missing authorization code.")}`
  );
}

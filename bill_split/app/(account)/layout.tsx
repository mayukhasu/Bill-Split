import { getSupabaseServerClient } from "@/lib/supabase/server";
import { signOut } from "@/lib/supabase/auth-actions";

// A "nested layout" — this wraps only the pages inside app/(account)/ (login, the OAuth
// callback has no UI, and everything under expenses/), stacking on top of the root
// app/layout.tsx rather than replacing it. Bill-split pages, living outside this folder,
// never render any of this and never trigger the Supabase call below.
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div>
      {user && (
        <div
          className="mb-6 flex items-center justify-between rounded-xl px-4 py-2 text-sm"
          style={{ background: "var(--color-brand-card)", border: "1.5px solid var(--color-brand-border)" }}
        >
          <span style={{ color: "var(--color-brand-muted)" }}>
            Signed in as <strong style={{ color: "var(--color-brand-text)" }}>{user.email}</strong>
          </span>
          <form action={signOut}>
            <button
              type="submit"
              className="font-semibold"
              style={{ color: "var(--color-brand-accent)" }}
            >
              Sign out
            </button>
          </form>
        </div>
      )}
      {children}
    </div>
  );
}

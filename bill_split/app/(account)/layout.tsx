import Link from "next/link";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { signOut } from "@/lib/supabase/auth-actions";
import CloseDetailsOnOutsideClick from "@/components/CloseDetailsOnOutsideClick";
import styles from "./layout.module.css";

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
      <CloseDetailsOnOutsideClick />
      {user && (
        <div className={styles.bar}>
          <span className={styles.signedInText}>
            Signed in as <strong>{user.email}</strong>
          </span>
          {/* Same native <details> pattern as the dashboard's row-actions menu — no Client
              Component/JS needed, and it fixes the narrow-screen layout bug where a separate
              gear icon + "Sign out" button had no room to sit side by side with a long email
              (it was wrapping/overlapping). One toggle, one dropdown. */}
          <details className={styles.menu}>
            <summary className={styles.menuToggle} aria-label="Account menu">☰</summary>
            <div className={styles.menuPanel}>
              <Link href="/settings" className={styles.menuLink}>
                Settings
              </Link>
              <Link href="/expenses" className={styles.menuLink}>
                Dashboard
              </Link>
              <form action={signOut}>
                <button type="submit" className={styles.menuSignOut}>
                  Sign out
                </button>
              </form>
            </div>
          </details>
        </div>
      )}
      {children}
    </div>
  );
}

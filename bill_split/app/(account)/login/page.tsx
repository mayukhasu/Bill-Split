import { signInWithGoogle } from "@/lib/supabase/auth-actions";
import styles from "./page.module.css";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <div className={styles.card}>
      <h1 className={styles.title}>Sign in</h1>
      <p className={styles.subtitle}>
        Sign in with Google to track your expenses.
      </p>

      {error && <p className={styles.error}>{error}</p>}

      <form action={signInWithGoogle}>
        <input type="hidden" name="next" value={next ?? "/expenses"} />
        <button type="submit" className={styles.signInButton}>
          Continue with Google
        </button>
      </form>
    </div>
  );
}

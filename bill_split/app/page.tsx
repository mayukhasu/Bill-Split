import Link from "next/link";
import styles from "./page.module.css";

// The actual app landing page — picks between the two independent tools this project
// bundles. Note this is a plain Server Component with no Supabase calls at all: it doesn't
// need to know whether you're signed in, since each destination handles that itself
// (bill-split never checks; /expenses redirects to /login on its own if needed).
export default function HomePage() {
  return (
    <div className={styles.hero}>
      <h1 className={styles.title}>Welcome to MoneySplit</h1>
      <p className={styles.subtitle}>
        Two tools, one app. Pick what you need right now.
      </p>

      <div className={styles.options}>
        <Link href="/bill-split" className={styles.optionCard}>
          <div className={styles.optionTitle}>Split a Bill</div>
          <p className={styles.optionDescription}>
            Scan a receipt, assign items to people, and settle up — no account needed.
          </p>
        </Link>

        <Link href="/expenses" className={styles.optionCard}>
          <div className={styles.optionTitle}>Track Expenses</div>
          <p className={styles.optionDescription}>
            Sign in to log and categorize your own spending over time.
          </p>
        </Link>
      </div>
    </div>
  );
}

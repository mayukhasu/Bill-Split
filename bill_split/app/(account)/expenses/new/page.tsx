import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getCategories } from "@/lib/expenses/queries";
import { createExpense } from "../actions";
import styles from "./page.module.css";

// A server-computed "today," used only as the date field's pre-filled default. Since this
// renders on the server, it reflects the server's own timezone, not necessarily yours — if
// you're far from UTC and it's near midnight, the pre-filled date could be off by one. It's
// just a convenience default you can freely overwrite, not a forced value, so that's an
// acceptable tradeoff for now rather than pulling in a Client Component just for this.
function getServerTodayDateString() {
  return new Intl.DateTimeFormat("en-CA").format(new Date()); // en-CA formats as YYYY-MM-DD
}

const PAYMENT_METHOD_OPTIONS = ["card", "cash", "Zelle/Venmo", "check", "other"];

export default async function NewExpensePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/expenses/new");

  const { error } = await searchParams;
  const categories = await getCategories();

  return (
    <div className={styles.card}>
      <h1 className={styles.title}>Add Expense</h1>
      {error && <p className={styles.error}>{error}</p>}

      <form action={createExpense}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="amount">Amount</label>
          <input
            id="amount"
            name="amount"
            type="number"
            min="0.01"
            step="1.00"
            required
            className={styles.input}
            placeholder="0.00"
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="categoryId">Category</label>
          <select id="categoryId" name="categoryId" required className={styles.select}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="expenseDate">
            Date <span className={styles.optionalHint}>(defaults to today)</span>
          </label>
          <input
            id="expenseDate"
            name="expenseDate"
            type="date"
            defaultValue={getServerTodayDateString()}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="merchant">Merchant</label>
          <input id="merchant" name="merchant" type="text" required className={styles.input} />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="paymentMethodType">Payment Method</label>
          <select
            id="paymentMethodType"
            name="paymentMethodType"
            defaultValue="card"
            className={styles.select}
          >
            {PAYMENT_METHOD_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="cardNickname">
            Card Nickname <span className={styles.optionalHint}>(optional)</span>
          </label>
          <input
            id="cardNickname"
            name="cardNickname"
            type="text"
            placeholder="e.g. Chase Sapphire — not a real card number"
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="note">
            Note <span className={styles.optionalHint}>(optional)</span>
          </label>
          <textarea id="note" name="note" className={styles.textarea} />
        </div>

        <button type="submit" className={styles.submitButton}>
          Save Expense
        </button>
      </form>
    </div>
  );
}

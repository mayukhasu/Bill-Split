import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getCategories, getSavedValues } from "@/lib/expenses/queries";
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
  const [categories, savedMerchants, savedCardNicknames] = await Promise.all([
    getCategories(),
    getSavedValues("merchant"),
    getSavedValues("card_nickname"),
  ]);

  return (
    <div className={styles.card}>
      <div className={styles.pageHeader}>
        <h1 className={styles.title}>Add Expense</h1>
        {/* Submits the SAME form as the Save button, just with a different `intent` value —
            createExpense reads that to redirect to this new expense's scan page instead of
            the dashboard once it's saved, and fills in placeholder values for anything left
            blank (the whole point of this button is skipping manual entry before scanning).
            `form="expenseForm"` is what lets a button outside the <form> tag (useful for this
            top-right placement) still submit it. `formNoValidate` skips the browser's native
            required-field validation for this submission specifically — the normal Save
            button still enforces it normally. */}
        <button
          type="submit"
          name="intent"
          value="scan"
          form="expenseForm"
          formNoValidate
          className={styles.scanHeaderButton}
        >
          Scan Receipt
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}

      <form id="expenseForm" action={createExpense}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="amount">Amount</label>
          <input
            id="amount"
            name="amount"
            type="number"
            min="0.01"
            step="0.01"
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
          {/* <datalist> gives native type-to-filter-or-type-anything suggestions with zero
              JS/dependencies — picking a listed option or typing something new both just
              work as normal text input. */}
          <input id="merchant" name="merchant" type="text" required list="merchantOptions" className={styles.input} />
          <datalist id="merchantOptions">
            {savedMerchants.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
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
            list="cardNicknameOptions"
            placeholder="e.g. Chase Sapphire — not a real card number"
            className={styles.input}
          />
          <datalist id="cardNicknameOptions">
            {savedCardNicknames.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="note">
            Note <span className={styles.optionalHint}>(optional)</span>
          </label>
          <textarea id="note" name="note" className={styles.textarea} />
        </div>

        <div className={styles.actionsRow}>
          <Link href="/expenses" className={styles.secondaryButton}>
            Cancel
          </Link>
          <button type="submit" className={styles.submitButton}>
            Save Expense
          </button>
        </div>
      </form>
    </div>
  );
}

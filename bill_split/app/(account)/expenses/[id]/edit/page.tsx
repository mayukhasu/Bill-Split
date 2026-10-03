import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getCategories, getExpenseById } from "@/lib/expenses/queries";
import { updateExpense } from "../../actions";
// Reusing the new-expense form's stylesheet — Next.js CSS Modules work fine imported from a
// sibling-ish route; the classnames it generates don't care which page imports them.
import styles from "../../new/page.module.css";

const PAYMENT_METHOD_OPTIONS = ["card", "cash", "bank transfer", "check", "other"];

export default async function EditExpensePage({
  params,
  searchParams,
}: {
  // Dynamic route segments ([id] in the folder name) arrive the same way searchParams
  // does in this Next.js version — as a Promise you await, not a plain object.
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const { error } = await searchParams;

  const [expense, categories] = await Promise.all([getExpenseById(id), getCategories()]);

  // getExpenseById returns null both when the row doesn't exist AND when it belongs to
  // someone else — intentionally indistinguishable from the outside (see its comment in
  // queries.ts). Either way, there's nothing to edit, so just go back to the dashboard.
  if (!expense) redirect("/expenses");

  return (
    <div className={styles.card}>
      <h1 className={styles.title}>Edit Expense</h1>
      {error && <p className={styles.error}>{error}</p>}

      <form action={updateExpense}>
        <input type="hidden" name="id" value={expense.id} />

        <div className={styles.field}>
          <label className={styles.label} htmlFor="amount">Amount</label>
          <input
            id="amount"
            name="amount"
            type="number"
            min="0.01"
            step="1.00"
            required
            defaultValue={expense.amount}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="categoryId">Category</label>
          <select
            id="categoryId"
            name="categoryId"
            required
            defaultValue={expense.categoryId}
            className={styles.select}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="expenseDate">Date</label>
          <input
            id="expenseDate"
            name="expenseDate"
            type="date"
            defaultValue={expense.expenseDate}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="merchant">Merchant</label>
          <input
            id="merchant"
            name="merchant"
            type="text"
            required
            defaultValue={expense.merchant}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="paymentMethodType">Payment Method</label>
          <select
            id="paymentMethodType"
            name="paymentMethodType"
            defaultValue={expense.paymentMethodType}
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
            defaultValue={expense.cardNickname ?? ""}
            className={styles.input}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="note">
            Note <span className={styles.optionalHint}>(optional)</span>
          </label>
          <textarea id="note" name="note" defaultValue={expense.note ?? ""} className={styles.textarea} />
        </div>

        <button type="submit" className={styles.submitButton}>
          Save Changes
        </button>
      </form>

      <Link href={`/expenses/${expense.id}/scan`} className={styles.scanLink}>
        {expense.lineItems.length > 0
          ? `Edit receipt breakdown (${expense.lineItems.length} items)`
          : "Scan receipt to break this into categories"}
      </Link>
    </div>
  );
}

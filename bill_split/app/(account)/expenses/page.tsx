import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getExpensesForCurrentUser, computeTotalsByCategory, computeTotalsByMonth } from "@/lib/expenses/queries";
import { deleteExpense } from "./actions";
import styles from "./page.module.css";

function formatCurrency(amount: number) {
  return `$${amount.toFixed(2)}`;
}

export default async function ExpensesPage() {
  // Same auth check pattern everywhere a page needs to be protected — proxy.ts only
  // refreshes cookies, it never decides access, so every page like this one checks for
  // itself (see the comment in lib/supabase/proxy.ts for why).
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/expenses");

  const expenses = await getExpensesForCurrentUser();
  const totalsByCategory = computeTotalsByCategory(expenses);
  const totalsByMonth = computeTotalsByMonth(expenses);

  return (
    <div>
      <div className={styles.header}>
        <h1 className={styles.title}>Your Expenses</h1>
        <Link href="/expenses/new" className={styles.addButton}>
          + Add Expense
        </Link>
      </div>

      {expenses.length === 0 ? (
        <div className={styles.empty}>
          No expenses yet. Click &ldquo;+ Add Expense&rdquo; to log your first one.
        </div>
      ) : (
        <>
          <div className={styles.totalsGrid}>
            <div className={styles.totalsCard}>
              <div className={styles.totalsCardTitle}>By Category</div>
              {totalsByCategory.map((row) => (
                <div key={row.category} className={styles.totalsRow}>
                  <span>{row.category}</span>
                  <span>{formatCurrency(row.total)}</span>
                </div>
              ))}
            </div>
            <div className={styles.totalsCard}>
              <div className={styles.totalsCardTitle}>By Month</div>
              {totalsByMonth.map((row) => (
                <div key={row.month} className={styles.totalsRow}>
                  <span>{row.month}</span>
                  <span>{formatCurrency(row.total)}</span>
                </div>
              ))}
            </div>
          </div>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Merchant</th>
                <th>Category</th>
                <th>Payment</th>
                <th>Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {expenses.map((expense) => (
                <tr key={expense.id}>
                  <td>{expense.expenseDate}</td>
                  <td>{expense.merchant}</td>
                  <td>{expense.categoryName}</td>
                  <td>
                    {expense.paymentMethodType}
                    {expense.cardNickname ? ` · ${expense.cardNickname}` : ""}
                  </td>
                  <td>{formatCurrency(expense.amount)}</td>
                  <td>
                    <div className={styles.rowActions}>
                      <Link href={`/expenses/${expense.id}/edit`} className={styles.editLink}>
                        Edit
                      </Link>
                      <Link href={`/expenses/${expense.id}/scan`} className={styles.editLink}>
                        {expense.lineItems.length > 0 ? "Re-scan" : "Scan receipt"}
                      </Link>
                      {/* A form per row, not a single shared delete button — each one posts
                          its own hidden `id` field straight to the deleteExpense Server
                          Action, no client-side state or onClick handler needed. */}
                      <form action={deleteExpense}>
                        <input type="hidden" name="id" value={expense.id} />
                        <button type="submit" className={styles.deleteButton}>
                          Delete
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

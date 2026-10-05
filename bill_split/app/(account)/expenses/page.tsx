import Link from "next/link";
import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getExpensesForCurrentUser, computeTotalsByCategory, computeTotalsByMonth } from "@/lib/expenses/queries";
import { deleteExpense } from "./actions";
import SaveValueBanner from "./SaveValueBanner";
import styles from "./page.module.css";

function formatCurrency(amount: number) {
  return `$${amount.toFixed(2)}`;
}

// expense.categoryName is just the fallback category_id on the expense row — for a scanned
// receipt that's often a placeholder (e.g. "Groceries", the first active category used to
// satisfy the scan-shortcut's NOT NULL constraint) and is never updated once line items with
// their own categories exist. Showing it as if it were "the" category is misleading once a
// receipt has been broken down, so a scanned expense displays its line items' own category
// instead — collapsing to "Split" when those line items don't all agree.
function categoryDisplay(expense: { categoryName: string; lineItems: { categoryName: string }[] }) {
  if (expense.lineItems.length === 0) return expense.categoryName;
  const distinct = new Set(expense.lineItems.map((item) => item.categoryName));
  return distinct.size === 1 ? [...distinct][0] : "Split";
}

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{ newMerchant?: string; newCard?: string }>;
}) {
  // Same auth check pattern everywhere a page needs to be protected — proxy.ts only
  // refreshes cookies, it never decides access, so every page like this one checks for
  // itself (see the comment in lib/supabase/proxy.ts for why).
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/expenses");

  const { newMerchant, newCard } = await searchParams;
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

          {/* CSS-only toggle (no JS/Client Component needed): the checkbox is hidden, the
              label is styled as a button, and page.module.css uses the :checked sibling
              selector to show/hide .optionalCol cells on narrow screens. Unchecked on every
              load — nothing persisted, which is fine since nothing was asked for there. */}
          <input type="checkbox" id="showMoreColumns" className={styles.columnToggleInput} />
          <label htmlFor="showMoreColumns" className={styles.columnToggleLabel}>
            Show date &amp; payment
          </label>

          {/* overflow-x wrapper, not the table itself — lets the table scroll horizontally
              if content still doesn't fit (e.g. a long merchant name), rather than blowing
              out the whole page's width. */}
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th className={styles.optionalCol}>Date</th>
                  <th>Merchant</th>
                  <th>Category</th>
                  <th className={styles.optionalCol}>Payment</th>
                  <th>Amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {expenses.map((expense) => (
                  <tr key={expense.id}>
                    <td className={styles.optionalCol}>{expense.expenseDate}</td>
                    <td>{expense.merchant}</td>
                    <td>{categoryDisplay(expense)}</td>
                    <td className={styles.optionalCol}>
                      {expense.paymentMethodType}
                      {expense.cardNickname ? ` · ${expense.cardNickname}` : ""}
                    </td>
                    <td>{formatCurrency(expense.amount)}</td>
                    <td>
                      {/* A native <details> instead of a custom dropdown — no Client
                          Component/open-close state needed, this page stays a Server
                          Component. Trade-off: it only closes by re-clicking the toggle, not
                          by clicking elsewhere on the page — fine for a 3-item menu. */}
                      <details className={styles.rowMenu}>
                        <summary className={styles.rowMenuToggle}>⋮</summary>
                        <div className={styles.rowMenuPanel}>
                          <Link href={`/expenses/${expense.id}/edit`} className={styles.editLink}>
                            Edit
                          </Link>
                          <Link href={`/expenses/${expense.id}/scan`} className={styles.editLink}>
                            {expense.lineItems.length > 0 ? "Re-scan" : "Scan receipt"}
                          </Link>
                          {/* A form per row, not a single shared delete button — each one
                              posts its own hidden `id` field straight to the deleteExpense
                              Server Action, no client-side state or onClick handler needed. */}
                          <form action={deleteExpense}>
                            <input type="hidden" name="id" value={expense.id} />
                            <button type="submit" className={styles.deleteButton}>
                              Delete
                            </button>
                          </form>
                        </div>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <SaveValueBanner newMerchant={newMerchant} newCard={newCard} />
    </div>
  );
}

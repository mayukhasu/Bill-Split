// Mirrors the public.categories table (see the SQL in the implementation plan).
export type Category = {
  id: string;
  name: string;
};

// Mirrors the public.expenses table, joined with its category name for display —
// Supabase's query builder can pull the related category.name in one round trip
// (see getExpensesForCurrentUser in queries.ts) rather than a second query per row.
export type Expense = {
  id: string;
  amount: number;
  categoryId: string;
  categoryName: string;
  // Plain "YYYY-MM-DD" string, deliberately not a Date object — see the note in
  // queries.ts/the add-expense form about why a date-only value should never round-trip
  // through JS's Date type. Always populated (defaults to today at the database level if
  // left blank when created) — unlike cardNickname below, a missing date would make the
  // totals-by-month dashboard meaningless for that row, so this one stays non-null.
  expenseDate: string;
  merchant: string;
  // How the expense was paid (e.g. "card", "cash", "bank transfer") — a free-form string,
  // not a fixed list, so new payment types never need a migration. Defaults to "card".
  paymentMethodType: string;
  // Which specific card, e.g. "Chase Sapphire" — only meaningful when paymentMethodType is
  // "card"-ish, so it's nullable: a cash expense has no card nickname at all.
  cardNickname: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  // Storage object path for a scanned receipt (e.g. "<user_id>/<expense_id>/receipt.jpg"),
  // never a public URL — the "receipts" bucket is private, so viewing it means minting a
  // short-lived signed URL server-side (see getReceiptSignedUrl in queries.ts). Null until
  // a receipt has been scanned and saved for this expense.
  receiptPath: string | null;
  // The expense's category breakdown, from public.expense_line_items. Empty array (never
  // undefined) when the expense has no breakdown — in that case categoryId/categoryName
  // above are the whole story. When non-empty, these line items' own categories are what
  // the dashboard totals should use instead of the parent category — see
  // computeTotalsByCategory in queries.ts.
  lineItems: LineItem[];
};

// A single category-tagged row within an expense's receipt breakdown. Mirrors
// public.expense_line_items, joined with its category name the same way Expense joins
// categories above.
//
// totalCost is NOT simply quantity * unitCost — it's that raw cost PLUS this row's
// proportional share of the receipt's tax+tip, i.e.
//   totalCost = quantity * unitCost + (quantity * unitCost / subtotalOfAllRows) * (tax + tip)
// so that every dollar on the receipt, tax and tip included, lands in some category instead
// of quietly vanishing. unitCost stays the plain per-unit price (what's shown/edited
// directly); the tax/tip add-on is only ever a derived display value, computed as
// `totalCost - quantity * unitCost` — see ScanReceiptClient.tsx.
export type LineItem = {
  id: string;
  name: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  categoryId: string;
  categoryName: string;
};

// What the scan page submits per row when saving a breakdown — no id, since these rows
// are deleted and reinserted wholesale each save (see saveLineItems in the scan feature's
// actions.ts), so the database assigns fresh ids. totalCost here is already the
// tax/tip-inclusive figure described on LineItem above, computed client-side before submit.
export type LineItemInput = {
  name: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
  categoryId: string;
};

// What the add/edit forms submit. expenseDate is still required here — the form itself
// pre-fills it with today's date by default, so by the time this type is used it already
// has a value; "optional in practice" is handled by that default, not by allowing blank.
export type ExpenseInput = {
  amount: number;
  categoryId: string;
  expenseDate: string;
  merchant: string;
  paymentMethodType: string;
  cardNickname: string | null;
  note: string | null;
};

import { getSupabaseServerClient } from "@/lib/supabase/server";
import type { Category, Expense } from "@/lib/expenses/types";

// Fetches the signed-in user's own expenses, joined with their category name in one round
// trip (Supabase's query builder follows the category_id foreign key automatically when you
// name the related table in .select()). We still filter by user_id explicitly even though
// RLS already enforces it server-side — cheap defense-in-depth, and it makes the intent
// obvious to anyone reading this function later.
export async function getExpensesForCurrentUser(): Promise<Expense[]> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("expenses")
    .select(
      "id, amount, category_id, expense_date, merchant, payment_method_type, card_nickname, note, created_at, updated_at, receipt_path, categories(name), expense_line_items(id, name, quantity, unit_cost, total_cost, category_id, categories(name))"
    )
    .eq("user_id", user.id)
    .order("expense_date", { ascending: false });

  if (error || !data) return [];

  // Supabase returns the joined `categories` relation as a single nested object here
  // (not an array) since category_id -> categories.id is a many-to-one link: each expense
  // has exactly one category. `expense_line_items`, by contrast, is one-to-many — one
  // expense can have many line items — so Supabase returns *that* as an array, and each
  // line item carries its own nested `categories` object the same way the parent does.
  // Mapping snake_case DB columns to the camelCase Expense/LineItem types.
  return data.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    categoryId: row.category_id,
    categoryName: (row.categories as unknown as { name: string } | null)?.name ?? "Uncategorized",
    expenseDate: row.expense_date,
    merchant: row.merchant,
    paymentMethodType: row.payment_method_type,
    cardNickname: row.card_nickname,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    receiptPath: row.receipt_path,
    lineItems: (
      row.expense_line_items as unknown as {
        id: string;
        name: string;
        quantity: number;
        unit_cost: number;
        total_cost: number;
        category_id: string;
        categories: { name: string } | null;
      }[]
    ).map((item) => ({
      id: item.id,
      name: item.name,
      quantity: Number(item.quantity),
      unitCost: Number(item.unit_cost),
      totalCost: Number(item.total_cost),
      categoryId: item.category_id,
      categoryName: item.categories?.name ?? "Uncategorized",
    })),
  }));
}

// Fetches a single expense by id, scoped to the current user (RLS enforces this too, but a
// row that doesn't belong to you should look exactly like a row that doesn't exist at all —
// returning null either way, rather than leaking "it exists, you just can't see it").
export async function getExpenseById(id: string): Promise<Expense | null> {
  const expenses = await getExpensesForCurrentUser();
  return expenses.find((expense) => expense.id === id) ?? null;
}

// Active categories only, ordered for a dropdown. No user filter — categories are shared
// reference data, readable by any authenticated user (see the RLS policy in the SQL script).
export async function getCategories(): Promise<Category[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("categories")
    .select("id, name")
    .eq("is_active", true)
    .order("sort_order");

  if (error || !data) return [];
  return data;
}

// A user's saved merchant names / card nicknames, for the <datalist> suggestions on the
// expense form — unlike categories, this IS user-scoped (everyone's own frequent merchants
// are different), hence the explicit user_id filter here.
export async function getSavedValues(kind: "merchant" | "card_nickname"): Promise<string[]> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("saved_expense_values")
    .select("value")
    .eq("user_id", user.id)
    .eq("kind", kind)
    .order("value");

  if (error || !data) return [];
  return data.map((row) => row.value);
}

// A scanned, categorized receipt only ever lives in Supabase Storage, in a private bucket
// (public = false), so there's no bare URL that just works — this mints one that does, but
// only for 60 seconds, and only after confirming the expense (and therefore the receipt)
// belongs to the current user: createSignedUrl itself is RLS-gated, so it would fail for
// someone else's receipt before ever producing a token. Call it fresh each time you need to
// show the image; don't cache the URL itself.
export async function getReceiptSignedUrl(expenseId: string): Promise<string | null> {
  const expense = await getExpenseById(expenseId);
  if (!expense || !expense.receiptPath) return null;

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.storage
    .from("receipts")
    .createSignedUrl(expense.receiptPath, 60);

  if (error || !data) return null;
  return data.signedUrl;
}

export function computeTotalsByCategory(expenses: Expense[]): { category: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const expense of expenses) {
    // An expense with a saved receipt breakdown should have its spend split across each
    // line item's own category, not lumped under the expense's single parent category —
    // that's the whole point of scanning a Costco/Walmart receipt. An expense with no
    // breakdown (lineItems is always an array, never undefined — see types.ts) falls back
    // to its own categoryName/amount exactly as before.
    if (expense.lineItems.length > 0) {
      for (const item of expense.lineItems) {
        totals.set(item.categoryName, (totals.get(item.categoryName) ?? 0) + item.totalCost);
      }
    } else {
      totals.set(expense.categoryName, (totals.get(expense.categoryName) ?? 0) + expense.amount);
    }
  }
  return Array.from(totals, ([category, total]) => ({ category, total })).sort(
    (a, b) => b.total - a.total
  );
}

export function computeTotalsByMonth(expenses: Expense[]): { month: string; total: number }[] {
  const totals = new Map<string, number>();
  for (const expense of expenses) {
    // "2026-10-01" -> "2026-10" — group by year+month, string-sliced rather than parsed
    // through Date, for the same timezone-safety reason noted in lib/expenses/types.ts.
    const month = expense.expenseDate.slice(0, 7);
    totals.set(month, (totals.get(month) ?? 0) + expense.amount);
  }
  return Array.from(totals, ([month, total]) => ({ month, total })).sort((a, b) =>
    b.month.localeCompare(a.month)
  );
}

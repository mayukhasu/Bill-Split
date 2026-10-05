"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getExpenseById } from "@/lib/expenses/queries";
import type { LineItemInput } from "@/lib/expenses/types";

// Same shape-validation pattern as app/(account)/expenses/actions.ts's parseExpenseForm:
// pull the fields out of FormData, validate, and return either a clean object or an error
// string. The client component JSON.stringifies the row list into one hidden field — a
// variable-length array of rows doesn't map onto repeated FormData keys the way the expense
// form's fixed fields do. Each item's totalCost already has its proportional tax/tip share
// folded in by the client, allocated so the rows sum to the receipt's total to the exact
// cent (see allocateLineItemTotals in lib/receipt-scan/allocateLineItemTotals.ts) — this
// function just validates the numbers it's given, it doesn't recompute that allocation.
function parseLineItemsForm(formData: FormData): { error: string } | {
  error: null;
  expenseId: string;
  items: LineItemInput[];
  receiptPath: string | null;
} {
  const expenseId = (formData.get("expenseId") as string | null) ?? "";
  const itemsRaw = (formData.get("items") as string | null) ?? "";
  const receiptPathRaw = (formData.get("receiptPath") as string | null) ?? "";

  if (!expenseId) return { error: "Missing expense." };

  let parsedItems: unknown;
  try {
    parsedItems = JSON.parse(itemsRaw);
  } catch {
    return { error: "Could not read the submitted rows." };
  }
  if (!Array.isArray(parsedItems) || parsedItems.length === 0) {
    return { error: "Add at least one row before saving." };
  }

  const items: LineItemInput[] = [];
  for (const raw of parsedItems) {
    const name = typeof raw?.name === "string" ? raw.name.trim() : "";
    const quantity = Number(raw?.quantity);
    const unitCost = Number(raw?.unitCost);
    const totalCost = Number(raw?.totalCost);
    const categoryId = typeof raw?.categoryId === "string" ? raw.categoryId : "";

    if (!name) return { error: "Every row needs a name." };
    if (!Number.isFinite(quantity) || quantity <= 0) return { error: `"${name}" needs a quantity greater than 0.` };
    if (!Number.isFinite(unitCost) || unitCost < 0) return { error: `"${name}" needs a valid cost.` };
    if (!Number.isFinite(totalCost) || totalCost < 0) return { error: `"${name}" needs a valid total.` };
    if (!categoryId) return { error: `Pick a category for "${name}".` };

    items.push({ name, quantity, unitCost, totalCost, categoryId });
  }

  return { error: null, expenseId, items, receiptPath: receiptPathRaw || null };
}

// Keeps Storage usage bounded as more users/receipts accumulate: only the 10 most recently
// uploaded receipts per user are kept. Since receipts are uploaded one at a time, there's
// normally at most one excess row to prune per call — so rather than fetching every
// receipt-bearing expense and slicing it in JS, this asks Postgres directly for whatever
// sits PAST position 10 (`.range`, backed by the partial index on receipt_uploaded_at), which
// stays cheap as the table grows and needs no separate "what's next to delete" bookkeeping
// that could drift out of sync with the real expenses table. A small safety margin beyond 1
// row covers edge cases (e.g. the limit being lowered later) without changing the normal-case
// cost at all — the range is still a handful of rows, not the whole list.
const RECEIPT_RETENTION_LIMIT = 10;
const RECEIPT_PRUNE_SAFETY_MARGIN = 5;

async function pruneOldReceipts(supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>, userId: string) {
  const { data, error } = await supabase
    .from("expenses")
    .select("id, receipt_path")
    .eq("user_id", userId)
    .not("receipt_path", "is", null)
    .order("receipt_uploaded_at", { ascending: false })
    .range(RECEIPT_RETENTION_LIMIT, RECEIPT_RETENTION_LIMIT + RECEIPT_PRUNE_SAFETY_MARGIN - 1);
  if (error || !data || data.length === 0) return;

  const paths = data.map((row) => row.receipt_path).filter((path): path is string => Boolean(path));
  if (paths.length > 0) {
    await supabase.storage.from("receipts").remove(paths);
  }
  await supabase
    .from("expenses")
    .update({ receipt_path: null, receipt_uploaded_at: null })
    .in(
      "id",
      data.map((row) => row.id)
    );
}

// Replaces an expense's entire line-item breakdown and recomputes its amount from the new
// rows' totals. Deleting-then-inserting (rather than diffing) is the simplest correct thing
// here — the scan page always submits its full current row list, never a partial edit, so
// there's nothing to reconcile against the old rows.
export async function saveLineItems(formData: FormData) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const parsed = parseLineItemsForm(formData);
  if (parsed.error !== null) {
    const expenseId = (formData.get("expenseId") as string | null) ?? "";
    redirect(`/expenses/${expenseId}/scan?error=${encodeURIComponent(parsed.error)}`);
  }

  // Confirms the expense exists AND belongs to this user before touching anything — RLS
  // would also block the writes below, but checking here first avoids a confusing "it half
  // succeeded" state and lets us redirect somewhere sensible instead of just failing.
  const expense = await getExpenseById(parsed.expenseId);
  if (!expense) redirect("/expenses");

  const { error: deleteError } = await supabase
    .from("expense_line_items")
    .delete()
    .eq("expense_id", parsed.expenseId);
  if (deleteError) {
    redirect(`/expenses/${parsed.expenseId}/scan?error=${encodeURIComponent(deleteError.message)}`);
  }

  const { error: insertError } = await supabase.from("expense_line_items").insert(
    parsed.items.map((item, index) => ({
      expense_id: parsed.expenseId,
      category_id: item.categoryId,
      name: item.name,
      quantity: item.quantity,
      unit_cost: item.unitCost,
      total_cost: item.totalCost,
      sort_order: index,
    }))
  );
  if (insertError) {
    redirect(`/expenses/${parsed.expenseId}/scan?error=${encodeURIComponent(insertError.message)}`);
  }

  // Each item's totalCost already includes its exact-to-the-cent share of tax+tip (see
  // allocateLineItemTotals), so this sum equals the receipt's real total, not just the
  // items' sticker prices.
  const amount = parsed.items.reduce((sum, item) => sum + item.totalCost, 0);
  const updateValues: Record<string, unknown> = { amount };
  // Only overwrite receipt_path when this submission actually uploaded a new file — omitting
  // the key (rather than sending null) leaves a previously-saved receipt untouched if the
  // user is just re-categorizing rows without re-uploading. receipt_uploaded_at moves in
  // lockstep with receipt_path, since it exists purely to answer "which receipts are oldest"
  // for pruneOldReceipts below.
  if (parsed.receiptPath) {
    updateValues.receipt_path = parsed.receiptPath;
    updateValues.receipt_uploaded_at = new Date().toISOString();
  }

  const { error: updateError } = await supabase
    .from("expenses")
    .update(updateValues)
    .eq("id", parsed.expenseId);
  if (updateError) {
    redirect(`/expenses/${parsed.expenseId}/scan?error=${encodeURIComponent(updateError.message)}`);
  }

  // Only worth checking when this save actually added a new receipt — the count of
  // receipt-bearing expenses can't have grown otherwise.
  if (parsed.receiptPath) await pruneOldReceipts(supabase, user.id);

  revalidatePath("/expenses");
  revalidatePath(`/expenses/${parsed.expenseId}/edit`);
  redirect(`/expenses/${parsed.expenseId}/edit`);
}

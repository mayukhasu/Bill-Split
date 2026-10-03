"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSupabaseServerClient } from "@/lib/supabase/server";

// Pulls the shared form fields, validates the required ones, and returns either a clean
// object or a human-readable error string — shared by create and update so the two don't
// duplicate (and risk drifting out of sync on) the same validation rules.
//
// expenseDate and cardNickname are optional in the form:
//  - expenseDate, left blank, becomes `null` here — the caller omits it from the Supabase
//    insert/update payload entirely when null, so Postgres's `default current_date` fills
//    it in on create, or the existing value is simply left untouched on update.
//  - cardNickname, left blank, is stored as an actual `null` (not defaulted) — "no card"
//    is a meaningful, permanent answer for a cash/bank-transfer expense, not a placeholder.
function parseExpenseForm(formData: FormData): { error: string } | {
  error: null;
  amount: number;
  categoryId: string;
  expenseDate: string | null;
  merchant: string;
  paymentMethodType: string;
  cardNickname: string | null;
  note: string | null;
} {
  const amountRaw = formData.get("amount") as string | null;
  const categoryId = (formData.get("categoryId") as string | null) ?? "";
  const expenseDateRaw = ((formData.get("expenseDate") as string | null) ?? "").trim();
  const merchant = ((formData.get("merchant") as string | null) ?? "").trim();
  const paymentMethodTypeRaw = ((formData.get("paymentMethodType") as string | null) ?? "").trim();
  const cardNicknameRaw = ((formData.get("cardNickname") as string | null) ?? "").trim();
  const noteRaw = ((formData.get("note") as string | null) ?? "").trim();

  const amount = Number(amountRaw);
  if (!amountRaw || !Number.isFinite(amount) || amount <= 0) {
    return { error: "Enter an amount greater than $0." };
  }
  if (!categoryId) return { error: "Pick a category." };
  if (!merchant) return { error: "Enter a merchant." };

  return {
    error: null,
    amount,
    categoryId,
    expenseDate: expenseDateRaw || null,
    merchant,
    paymentMethodType: paymentMethodTypeRaw || "card",
    cardNickname: cardNicknameRaw || null,
    note: noteRaw || null,
  };
}

export async function createExpense(formData: FormData) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/expenses/new");

  const parsed = parseExpenseForm(formData);
  if (parsed.error !== null) {
    redirect(`/expenses/new?error=${encodeURIComponent(parsed.error)}`);
  }

  // Building the insert payload as a plain object, then conditionally adding expense_date
  // only when the form actually provided one — an omitted key (not an explicit `null`) is
  // what lets Postgres's column default (`current_date`) apply.
  const insertValues: Record<string, unknown> = {
    // user.id comes from the server-verified session above, never from the form — a client
    // can't submit a hidden "userId" field and have it accepted as someone else's.
    user_id: user.id,
    amount: parsed.amount,
    category_id: parsed.categoryId,
    merchant: parsed.merchant,
    payment_method_type: parsed.paymentMethodType,
    card_nickname: parsed.cardNickname,
    note: parsed.note,
  };
  if (parsed.expenseDate) insertValues.expense_date = parsed.expenseDate;

  const { error } = await supabase.from("expenses").insert(insertValues);

  if (error) {
    redirect(`/expenses/new?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/expenses");
  redirect("/expenses");
}

export async function updateExpense(formData: FormData) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const id = formData.get("id") as string | null;
  if (!id) redirect("/expenses");

  const parsed = parseExpenseForm(formData);
  if (parsed.error !== null) {
    redirect(`/expenses/${id}/edit?error=${encodeURIComponent(parsed.error)}`);
  }

  // Same omit-if-blank trick as createExpense, but it means something slightly different on
  // an update: there's no column default to fall back on here, so leaving expense_date out
  // of this object just leaves the existing value untouched, rather than resetting it.
  const updateValues: Record<string, unknown> = {
    amount: parsed.amount,
    category_id: parsed.categoryId,
    merchant: parsed.merchant,
    payment_method_type: parsed.paymentMethodType,
    card_nickname: parsed.cardNickname,
    note: parsed.note,
  };
  if (parsed.expenseDate) updateValues.expense_date = parsed.expenseDate;

  // No need to re-check "does this row belong to this user" ourselves — RLS's
  // expenses_update_own policy (auth.uid() = user_id) enforces that at the database level.
  // If someone ever submitted an id that isn't theirs, this simply updates zero rows.
  const { error } = await supabase.from("expenses").update(updateValues).eq("id", id);

  if (error) {
    redirect(`/expenses/${id}/edit?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/expenses");
  redirect("/expenses");
}

export async function deleteExpense(formData: FormData) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const id = formData.get("id") as string | null;
  if (!id) redirect("/expenses");

  // Same RLS reasoning as updateExpense — deleting a row that isn't yours is a no-op, not
  // an error.
  await supabase.from("expenses").delete().eq("id", id);

  revalidatePath("/expenses");
  redirect("/expenses");
}

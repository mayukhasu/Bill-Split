"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getSupabaseServerClient } from "@/lib/supabase/server";

type SavedValueKind = "merchant" | "card_nickname";

// Shared by confirmSaveValue (the banner's ✓) and addSavedValue (the settings page's manual
// add form) — both are "insert this value for this user" with the same tolerance for an
// already-saved duplicate. A plain insert, not an upsert: the unique index is on
// lower(value) (an expression), and Supabase's upsert(onConflict: "...") can only target a
// plain column list, not an expression index — it wouldn't match this constraint. Simplest
// correct thing is to just insert and tolerate the duplicate-key error (Postgres code 23505)
// if the value is already saved (e.g. a race with another tab) — a harmless no-op either way.
async function insertSavedValue(userId: string, kind: SavedValueKind, value: string) {
  const trimmed = value.trim();
  if (!trimmed) return;
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.from("saved_expense_values").insert({ user_id: userId, kind, value: trimmed });
  if (error && error.code !== "23505") throw new Error(error.message);
}

// Called directly from SaveValueBanner.tsx (a Client Component, via useTransition — same
// direct-call pattern as ScanReceiptClient's saveLineItems), not through a <form action>,
// since it takes typed arguments rather than reading a FormData. Only ever called when the
// user explicitly clicks the banner's ✓ — there's no auto-add path anywhere in this app.
export async function confirmSaveValue(kind: SavedValueKind, value: string) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  try {
    await insertSavedValue(user.id, kind, value);
  } catch (error) {
    // Best-effort: this runs from a dismissible banner with no error UI of its own, so a
    // failure here just means the suggestion wasn't saved — nothing else in the app depends
    // on it having succeeded. Still logged server-side (shows up in the `next dev` terminal)
    // so a silent failure here is at least diagnosable instead of invisible.
    console.error("confirmSaveValue failed:", error);
  }

  revalidatePath("/expenses/new");
  revalidatePath("/settings");
}

// Settings page's manual "add" form for each list — same underlying write as the banner's
// ✓, just reached a different way (typing a value directly rather than confirming a
// just-used one).
export async function addSavedValue(formData: FormData) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const kind = formData.get("kind") as SavedValueKind | null;
  const value = ((formData.get("value") as string | null) ?? "").trim();
  if (!kind || !value) redirect("/settings");

  try {
    await insertSavedValue(user.id, kind, value);
  } catch (error) {
    redirect(`/settings?error=${encodeURIComponent(error instanceof Error ? error.message : "Could not save.")}`);
  }

  revalidatePath("/settings");
  revalidatePath("/expenses/new");
  redirect("/settings");
}

// Settings page delete button — standard <form action={deleteSavedValue}> pattern, same as
// deleteExpense elsewhere in this app. RLS (saved_expense_values_delete_own) is what actually
// enforces you can only delete your own rows; no need to re-check ownership here.
export async function deleteSavedValue(formData: FormData) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const id = formData.get("id") as string | null;
  if (!id) redirect("/settings");

  await supabase.from("saved_expense_values").delete().eq("id", id);

  revalidatePath("/settings");
  revalidatePath("/expenses/new");
  redirect("/settings");
}

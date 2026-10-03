import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getCategories, getExpenseById } from "@/lib/expenses/queries";
import ScanReceiptClient from "./ScanReceiptClient";
import styles from "./page.module.css";

export default async function ScanReceiptPage({
  params,
  searchParams,
}: {
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

  // Same not-found/not-owned-is-indistinguishable pattern as the edit page — either way
  // there's nothing here to scan a receipt for.
  if (!expense) redirect("/expenses");

  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Scan Receipt — {expense.merchant}</h1>
      {error && <p className={styles.error}>{error}</p>}
      <ScanReceiptClient expense={expense} categories={categories} userId={user.id} />
    </div>
  );
}

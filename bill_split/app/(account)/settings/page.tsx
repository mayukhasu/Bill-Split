import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getSavedValues } from "@/lib/expenses/queries";
import { addSavedValue, deleteSavedValue } from "../expenses/saved-values-actions";
import styles from "./page.module.css";

// getSavedValues only returns the value strings (what the expense form's <datalist>s need),
// but deleting one requires its row id — so this page queries the table directly instead,
// rather than extending getSavedValues' return shape just for this one caller.
async function getSavedValueRows(kind: "merchant" | "card_nickname") {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("saved_expense_values")
    .select("id, value")
    .eq("user_id", user.id)
    .eq("kind", kind)
    .order("value");

  if (error || !data) return [];
  return data;
}

function SavedValueList({
  title,
  kind,
  rows,
  placeholder,
}: {
  title: string;
  kind: "merchant" | "card_nickname";
  rows: { id: string; value: string }[];
  placeholder: string;
}) {
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{title}</h2>

      {rows.length === 0 ? (
        <p className={styles.empty}>Nothing saved yet.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((row) => (
            <li key={row.id} className={styles.listRow}>
              <span>{row.value}</span>
              <form action={deleteSavedValue}>
                <input type="hidden" name="id" value={row.id} />
                <button type="submit" className={styles.deleteButton}>
                  Delete
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={addSavedValue} className={styles.addForm}>
        <input type="hidden" name="kind" value={kind} />
        <input type="text" name="value" placeholder={placeholder} required className={styles.input} />
        <button type="submit" className={styles.addButton}>
          Add
        </button>
      </form>
    </div>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/settings");

  const { error } = await searchParams;
  const [merchants, cardNicknames] = await Promise.all([
    getSavedValueRows("merchant"),
    getSavedValueRows("card_nickname"),
  ]);

  return (
    <div>
      <h1 className={styles.title}>Settings</h1>
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.grid}>
        <SavedValueList title="Saved Merchants" kind="merchant" rows={merchants} placeholder="e.g. Trader Joe's" />
        <SavedValueList
          title="Saved Card Nicknames"
          kind="card_nickname"
          rows={cardNicknames}
          placeholder="e.g. Chase Sapphire"
        />
      </div>
    </div>
  );
}

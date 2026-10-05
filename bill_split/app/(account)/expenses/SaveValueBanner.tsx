"use client";

import { useState, useTransition } from "react";
import { confirmSaveValue } from "./saved-values-actions";
import styles from "./page.module.css";

function SuggestionRow({
  kind,
  value,
  label,
}: {
  kind: "merchant" | "card_nickname";
  value: string;
  label: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [isPending, startTransition] = useTransition();

  if (dismissed) return null;

  return (
    <div className={styles.saveValueRow}>
      <span>
        Save <strong>{value}</strong> as a {label} you use often?
      </span>
      <div className={styles.saveValueActions}>
        <button
          type="button"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              await confirmSaveValue(kind, value);
              setDismissed(true);
            })
          }
          className={styles.saveValueConfirm}
          aria-label={`Save ${value}`}
        >
          ✓
        </button>
        <button type="button" onClick={() => setDismissed(true)} className={styles.saveValueDismiss} aria-label="Dismiss">
          ✕
        </button>
      </div>
    </div>
  );
}

// Shown once, right after creating/updating an expense, when the submitted merchant and/or
// card nickname weren't already in the user's saved list — see createExpense/updateExpense
// in actions.ts for how newMerchant/newCard get set. Ignoring this (navigating away, not
// clicking anything) is itself the "don't save" outcome — there's nothing to clean up, since
// nothing was written until/unless ✓ is clicked.
export default function SaveValueBanner({ newMerchant, newCard }: { newMerchant?: string; newCard?: string }) {
  if (!newMerchant && !newCard) return null;

  return (
    <div className={styles.saveValueBanner}>
      {newMerchant && <SuggestionRow kind="merchant" value={newMerchant} label="merchant" />}
      {newCard && <SuggestionRow kind="card_nickname" value={newCard} label="card nickname" />}
    </div>
  );
}

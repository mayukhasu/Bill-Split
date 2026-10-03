"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useRegionSelector } from "@/lib/receipt-scan/useRegionSelector";
import { scanReceipt, isSupportedReceiptFile } from "@/lib/receipt-scan/scanReceipt";
import { allocateLineItemTotals } from "@/lib/receipt-scan/allocateLineItemTotals";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { saveLineItems } from "./actions";
import type { Category, Expense } from "@/lib/expenses/types";
import type { ResizeHandle, SelectionTarget } from "@/lib/receipt-scan/types";
import styles from "./page.module.css";

// Only these targets matter for this feature — "fees"/"misc" exist as backend options but
// aren't part of the tax+tip allocation below, so drawing them here wouldn't do anything.
const SCAN_SELECTION_OPTIONS: { key: SelectionTarget; label: string; color: string }[] = [
  { key: "item", label: "Item Column", color: "#8F3A5F" },
  { key: "price", label: "Cost Column", color: "#8C9410" },
  { key: "tax", label: "Tax", color: "#6B2A47" },
  { key: "tip", label: "Tip", color: "#A9B01A" },
  { key: "total", label: "Total", color: "#C7CE3E" },
];

type EditableRow = {
  id: string;
  name: string;
  quantity: number;
  unitCost: number;
  categoryId: string;
};

function formatCurrency(amount: number) {
  return `$${amount.toFixed(2)}`;
}

export default function ScanReceiptClient({
  expense,
  categories,
  userId,
}: {
  expense: Expense;
  categories: Category[];
  userId: string;
}) {
  const router = useRouter();
  const region = useRegionSelector();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [receiptTotal, setReceiptTotal] = useState<number | null>(null);
  const [taxTotal, setTaxTotal] = useState<number | null>(null);
  const [tipTotal, setTipTotal] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Calling a Server Action directly from an event handler (rather than <form action={fn}>)
  // has to be wrapped in startTransition — that's what lets Next.js track the action and
  // handle its internal redirect() as a real navigation instead of just an ignored throw.
  // isSaving here is React's own isPending for that transition, not a manual flag.
  const [isSaving, startSaving] = useTransition();

  // Every row's share of tax+tip, allocated so the rows' totals sum to EXACTLY the
  // receipt's real total (see allocateLineItemTotals) — recomputed live as rows are edited,
  // so the breakdown always stays internally consistent while you work.
  const rawCosts = rows.map((row) => row.quantity * row.unitCost);
  const subtotal = rawCosts.reduce((sum, cost) => sum + cost, 0);
  const taxTip = (taxTotal ?? 0) + (tipTotal ?? 0);
  const target = receiptTotal ?? subtotal + taxTip;
  const allocatedTotals = allocateLineItemTotals(rawCosts, target);
  const rowsWithTotals = rows.map((row, index) => ({
    ...row,
    rawCost: rawCosts[index],
    totalCost: allocatedTotals[index],
    taxTipShare: allocatedTotals[index] - rawCosts[index],
  }));

  const allRowsCategorized = rows.length > 0 && rows.every((row) => row.categoryId);

  const handleFile = async (file: File) => {
    if (!isSupportedReceiptFile(file.name)) {
      setStatusMessage("Only PDF, HEIC, JPG, and PNG files are supported.");
      return;
    }
    setSelectedFile(file);
    region.resetForNewFile();
    setRows([]);
    setReceiptTotal(null);
    setTaxTotal(null);
    setTipTotal(null);
    setIsScanning(true);
    setStatusMessage("Preparing your receipt preview…");
    try {
      const data = await scanReceipt(file);
      region.setPreviewPages(data.preview?.pages ?? []);
      setStatusMessage(
        "Preview ready. Draw a box over the item names and another over the prices, then click Apply."
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not read the receipt.");
    } finally {
      setIsScanning(false);
    }
  };

  const applyRegions = async () => {
    if (!selectedFile || !region.hasCompletePage) return;
    setIsApplying(true);
    setStatusMessage("Applying your selected regions…");
    try {
      const data = await scanReceipt(selectedFile, region.regionsPayload);
      setRows(
        (data.itemRows ?? []).map((item) => ({
          id: item.id,
          name: item.name,
          quantity: item.quantity,
          unitCost: item.unitCost,
          categoryId: "",
        }))
      );
      setTaxTotal(data.summary?.tax ?? null);
      setTipTotal(data.summary?.tip ?? null);
      setReceiptTotal(data.summary?.total ?? null);
      setStatusMessage(`Found ${(data.itemRows ?? []).length} rows. Pick a category for each, then save.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not read the receipt.");
    } finally {
      setIsApplying(false);
    }
  };

  const updateRow = (id: string, field: "name" | "quantity" | "unitCost" | "categoryId", value: string) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        if (field === "name") return { ...row, name: value };
        if (field === "categoryId") return { ...row, categoryId: value };
        if (field === "quantity") return { ...row, quantity: Math.max(1, Number(value) || 1) };
        return { ...row, unitCost: Math.max(0, Number(value) || 0) };
      })
    );
  };

  const removeRow = (id: string) => setRows((prev) => prev.filter((row) => row.id !== id));

  const addRow = () =>
    setRows((prev) => [...prev, { id: `manual-${Date.now()}`, name: "", quantity: 1, unitCost: 0, categoryId: "" }]);

  const handleSave = () => {
    if (rows.length === 0 || !allRowsCategorized) return;
    setStatusMessage(null);

    startSaving(async () => {
      let receiptPath: string | null = null;
      if (selectedFile) {
        const path = `${userId}/${expense.id}/${crypto.randomUUID()}-${selectedFile.name}`;
        const { error } = await getSupabaseBrowserClient().storage.from("receipts").upload(path, selectedFile);
        if (error) {
          setStatusMessage(`Could not upload the receipt image: ${error.message}`);
          return;
        }
        receiptPath = path;
      }

      const formData = new FormData();
      formData.set("expenseId", expense.id);
      formData.set(
        "items",
        JSON.stringify(
          rowsWithTotals.map((row) => ({
            name: row.name,
            quantity: row.quantity,
            unitCost: row.unitCost,
            totalCost: row.totalCost,
            categoryId: row.categoryId,
          }))
        )
      );
      if (receiptPath) formData.set("receiptPath", receiptPath);

      // Calling the Server Action directly (not via <form action={...}>) because the Storage
      // upload above has to finish first — it's still the same "use server" function as
      // every other action in this app, just invoked as a plain call instead of a form
      // submit. It calls redirect() internally on success/error; wrapping this whole call in
      // startTransition (via startSaving above) is what lets Next.js track that and turn it
      // into a real client-side navigation instead of just an unhandled throw.
      await saveLineItems(formData);
    });
  };

  return (
    <div className={styles.card}>
      {!region.previewPages.length && (
        <div
          className={`${styles.dropZone} ${isDragOver ? styles.dropZoneActive : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void handleFile(file);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,application/pdf,.heic,.heif,image/heic,image/heif,.jpg,.jpeg,image/jpeg,.png,image/png"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleFile(file);
            }}
            className={styles.hiddenInput}
            disabled={isScanning}
          />
          <p className={styles.dropZoneText}>
            {isScanning ? "Reading receipt…" : "Drop a receipt photo or PDF, or click to browse"}
          </p>
        </div>
      )}

      {statusMessage && <p className={styles.statusText}>{statusMessage}</p>}

      {region.previewPages.length > 0 && rows.length === 0 && (
        <div className={styles.selectorSection}>
          {region.previewPages.length > 1 && (
            <div className={styles.toolbar}>
              {region.previewPages.map((_, pageIndex) => (
                <button
                  key={pageIndex}
                  type="button"
                  onClick={() => region.switchToPage(pageIndex)}
                  className={`${styles.toolbarButton} ${region.activePage === pageIndex ? styles.toolbarButtonActive : ""}`}
                >
                  Page {pageIndex + 1}
                </button>
              ))}
            </div>
          )}

          <div className={styles.toolbar}>
            {SCAN_SELECTION_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => region.setSelectionTarget(option.key)}
                className={`${styles.toolbarButton} ${region.selectionTarget === option.key ? styles.toolbarButtonActive : ""}`}
              >
                {option.label}
                {region.activePageRegions[option.key] ? " ✓" : ""}
              </button>
            ))}
          </div>
          <p className={styles.hint}>
            Item and Cost columns are required. Marking Tax/Tip/Total is optional, but lets the
            breakdown match the receipt exactly — otherwise tax and tip are left unallocated.
          </p>

          {region.activePreviewPage && (
            <div
              ref={region.previewContainerRef}
              className={styles.previewCanvas}
              onPointerDown={region.handlePreviewPointerDown}
              onPointerMove={region.handlePreviewPointerMove}
              onPointerUp={region.handlePreviewPointerUp}
              onPointerCancel={(e) => {
                region.releaseFullscreenPointer(e.pointerId);
                region.cancelInteraction();
              }}
              onPointerLeave={(e) => {
                region.releaseFullscreenPointer(e.pointerId);
                region.cancelInteraction();
              }}
            >
              <img
                src={`data:image/png;base64,${region.activePreviewPage.imageBase64}`}
                alt={`Receipt preview — page ${region.activePage + 1}`}
                className={styles.previewImage}
                draggable={false}
              />
              {SCAN_SELECTION_OPTIONS.map((option) => {
                const box = region.activePageRegions[option.key];
                if (!box) return null;
                return (
                  <div
                    key={option.key}
                    className={styles.selectedBox}
                    onPointerDown={(e) => region.handleBoxPointerDown(e, option.key)}
                    style={{
                      left: `${box.x * 100}%`,
                      top: `${box.y * 100}%`,
                      width: `${box.width * 100}%`,
                      height: `${box.height * 100}%`,
                      border: `2px solid ${option.color}`,
                      background: `${option.color}28`,
                    }}
                  >
                    <span className={styles.boxLabel}>{option.label}</span>
                    {(["nw", "ne", "sw", "se"] as ResizeHandle[]).map((handle) => (
                      <button
                        key={handle}
                        type="button"
                        className={`${styles.resizeHandle} ${styles[`handle${handle}`]}`}
                        onPointerDown={(e) => region.handleResizePointerDown(e, option.key, handle)}
                        aria-label={`Resize ${option.label}`}
                      />
                    ))}
                  </div>
                );
              })}
              {region.draftBox && (
                <div
                  className={styles.draftBox}
                  style={{
                    left: `${Math.min(region.draftBox.startX, region.draftBox.currentX)}px`,
                    top: `${Math.min(region.draftBox.startY, region.draftBox.currentY)}px`,
                    width: `${Math.abs(region.draftBox.currentX - region.draftBox.startX)}px`,
                    height: `${Math.abs(region.draftBox.currentY - region.draftBox.startY)}px`,
                  }}
                />
              )}
            </div>
          )}

          <button
            type="button"
            onClick={applyRegions}
            disabled={!region.hasCompletePage || isApplying}
            className={styles.primaryButton}
          >
            {isApplying ? "Applying…" : "Apply Selected Regions"}
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <div className={styles.rowsSection}>
          <div className={styles.summaryBar}>
            <span>Items: {formatCurrency(subtotal)}</span>
            <span>Tax + Tip: {formatCurrency(taxTip)}</span>
            <span>New total: {formatCurrency(target)}</span>
            <span className={styles.summaryMuted}>(was {formatCurrency(expense.amount)})</span>
          </div>

          <ol className={styles.rowsList}>
            {rowsWithTotals.map((row) => (
              <li key={row.id} className={styles.row}>
                <input
                  type="text"
                  value={row.name}
                  onChange={(e) => updateRow(row.id, "name", e.target.value)}
                  placeholder="Item name"
                  className={styles.rowName}
                />
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={row.quantity}
                  onChange={(e) => updateRow(row.id, "quantity", e.target.value)}
                  className={styles.rowNumber}
                  title="Quantity"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={row.unitCost}
                  onChange={(e) => updateRow(row.id, "unitCost", e.target.value)}
                  className={styles.rowNumber}
                  title="Cost per item"
                />
                <select
                  value={row.categoryId}
                  onChange={(e) => updateRow(row.id, "categoryId", e.target.value)}
                  className={styles.rowCategory}
                >
                  <option value="">Choose category…</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <span className={styles.rowTotal}>
                  {formatCurrency(row.rawCost)}
                  {row.taxTipShare > 0.001 && (
                    <span className={styles.rowTaxShare}> + {formatCurrency(row.taxTipShare)}</span>
                  )}
                </span>
                <button type="button" onClick={() => removeRow(row.id)} className={styles.rowRemove} aria-label="Remove row">
                  ×
                </button>
              </li>
            ))}
          </ol>

          <button type="button" onClick={addRow} className={styles.secondaryButton}>
            + Add row
          </button>

          <div className={styles.saveBar}>
            <button type="button" onClick={() => router.push(`/expenses/${expense.id}/edit`)} className={styles.secondaryButton}>
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!allRowsCategorized || isSaving}
              className={styles.primaryButton}
            >
              {isSaving ? "Saving…" : "Save Breakdown"}
            </button>
          </div>
          {!allRowsCategorized && <p className={styles.hint}>Pick a category for every row before saving.</p>}
        </div>
      )}
    </div>
  );
}

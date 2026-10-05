"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useRegionSelector } from "@/lib/receipt-scan/useRegionSelector";
import { scanReceipt, isSupportedReceiptFile } from "@/lib/receipt-scan/scanReceipt";
import { allocateLineItemTotals } from "@/lib/receipt-scan/allocateLineItemTotals";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { saveLineItems } from "./actions";
import type { Category, Expense } from "@/lib/expenses/types";
import { pageHasBothColumns, type ResizeHandle, type SelectionTarget } from "@/lib/receipt-scan/types";
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

// How far the scanned total can drift from the expense's current amount before we stop and
// ask which one is right, rather than silently picking one — half a cent, just enough to
// absorb float rounding, not enough to hide a real discrepancy.
const MISMATCH_TOLERANCE = 0.005;

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
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  // Freehand scratchpad overlay on the receipt composite — same technique as bill-split's
  // (a plain canvas drawn on with Pointer Events, cleared on demand), purely a visual aid for
  // cross-checking rows against the receipt while reviewing the scan; nothing here is saved.
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchDrawingRef = useRef(false);
  const scratchLastPointRef = useRef<{ x: number; y: number } | null>(null);

  // Two steps, same page: "review" is where the raw scan gets checked/fixed (names,
  // quantities, costs, tip, the receipt side-by-side) — nothing about categories yet.
  // "categorize" is reached via Continue once that's confirmed, and is purely about picking
  // a category per row. Kept as one component/URL rather than a second route — the state here
  // (rows, tip, totals) would otherwise have to be serialized somewhere (localStorage, query
  // params) to survive a real navigation, which is more fragile than just swapping views.
  const [step, setStep] = useState<"review" | "categorize">("review");

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [rows, setRows] = useState<EditableRow[]>([]);
  const [receiptTotal, setReceiptTotal] = useState<number | null>(null);
  const [taxTotal, setTaxTotal] = useState<number | null>(null);
  const [tipTotal, setTipTotal] = useState<number | null>(null);
  // Tip is editable two ways — a flat dollar amount, or a percentage of the items subtotal.
  // tipTotal (above) IS the dollar value in "amount" mode (still pre-filled from OCR's
  // summary.tip in applyRegions); tipPercentInput is only meaningful in "percent" mode.
  const [tipMode, setTipMode] = useState<"amount" | "percent">("amount");
  const [tipPercentInput, setTipPercentInput] = useState("");
  // Only meaningful when a "Total" box was marked (receiptTotal !== null): does that printed
  // total already include the tip, or does the tip need to be added on top of it? Tax is
  // virtually always already baked into a printed total (the register computes it before
  // printing), but tip is often written in by hand afterward — defaulting to "not included"
  // (tip added on top) matches that more common case.
  const [tipIncluded, setTipIncluded] = useState(false);
  // Set once the user resolves a scanned-vs-entered total mismatch (see hasMismatch below).
  // Reset to null on every new upload/re-scan so a stale choice never silently carries over.
  const [chosenTotal, setChosenTotal] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Calling a Server Action directly from an event handler (rather than <form action={fn}>)
  // has to be wrapped in startTransition — that's what lets Next.js track the action and
  // handle its internal redirect() as a real navigation instead of just an ignored throw.
  // isSaving here is React's own isPending for that transition, not a manual flag.
  const [isSaving, startSaving] = useTransition();

  // Pointer-based drag-to-reorder on the rows list — same approach as bill-split's detected
  // rows (native HTML5 drag-and-drop never fires on touch devices at all), just operating on
  // `rows` here instead of bill-split's own item list.
  const [draggedRowId, setDraggedRowId] = useState<string | null>(null);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);

  // Every row's share of tax+tip, allocated so the rows' totals sum to EXACTLY the target
  // total below — recomputed live as rows/tip are edited, so the breakdown always stays
  // internally consistent while you work.
  const rawCosts = rows.map((row) => row.quantity * row.unitCost);
  const subtotal = rawCosts.reduce((sum, cost) => sum + cost, 0);
  const effectiveTip = tipMode === "percent" ? subtotal * ((Number(tipPercentInput) || 0) / 100) : (tipTotal ?? 0);
  const taxTip = (taxTotal ?? 0) + effectiveTip;
  // If a "Total" box was marked, tax is virtually always already part of it (computed by the
  // register before printing) — but tip is only part of it when tipIncluded says so, since a
  // tip is often written in by hand after the fact and never makes it into what was scanned.
  // Adding effectiveTip again on top of receiptTotal when it's NOT already included is what
  // "the math gets mangled otherwise" was about: previously this unconditionally trusted
  // receiptTotal alone and silently dropped any tip the user had just entered.
  const scannedTotal =
    receiptTotal !== null ? receiptTotal + (tipIncluded ? 0 : effectiveTip) : subtotal + taxTip;

  // The "Scan Receipt" shortcut on the add-expense page creates the expense with a $0.01
  // placeholder amount (see createExpense in actions.ts) specifically so you can jump straight
  // here without entering one by hand — that placeholder was never a real figure to reconcile
  // against, so comparing the scan against it would just produce a nonsense "mismatch" on
  // every first-ever scan. Only treat the expense's amount as meaningful once it's actually
  // been confirmed once — i.e. it already has line items, or it's simply not the sentinel.
  const isPlaceholderAmount = expense.amount === 0.01 && expense.lineItems.length === 0;

  // If the receipt's scanned total doesn't match what's already on this expense (whether
  // that came from manual entry or an earlier scan), don't silently pick one — ask, and
  // block Save until it's resolved. The rows still show a live preview the whole time
  // (against scannedTotal by default, or the user's choice once made) rather than zeroing
  // out while blocked — canSave, not the displayed numbers, is what actually gates saving.
  const hasMismatch =
    !isPlaceholderAmount && rows.length > 0 && Math.abs(scannedTotal - expense.amount) > MISMATCH_TOLERANCE;
  const target = chosenTotal ?? scannedTotal;
  const canSave = !hasMismatch || chosenTotal !== null;

  const allocatedTotals = allocateLineItemTotals(rawCosts, target);
  const rowsWithTotals = rows.map((row, index) => ({
    ...row,
    rawCost: rawCosts[index],
    totalCost: allocatedTotals[index],
    taxTipShare: allocatedTotals[index] - rawCosts[index],
  }));

  const allRowsCategorized = rows.length > 0 && rows.every((row) => row.categoryId);

  const switchTipMode = (mode: "amount" | "percent") => {
    if (mode === tipMode) return;
    if (mode === "percent") {
      setTipPercentInput(subtotal > 0 ? (((tipTotal ?? 0) / subtotal) * 100).toFixed(1) : "0");
    } else {
      setTipTotal(Math.max(0, subtotal * ((Number(tipPercentInput) || 0) / 100)));
    }
    setTipMode(mode);
  };

  // Builds a side-by-side crop of just the item-name and price columns the user marked —
  // same technique as bill-split's receipt composite, scope-trimmed to whichever single page
  // currently has both columns marked (no multi-page switching — not asked for here). Only
  // shown during the "review" step (see the JSX below) — once you've moved on to assigning
  // categories, there's nothing left to cross-check against the receipt for.
  const [receiptComposite, setReceiptComposite] = useState<string | null>(null);

  useEffect(() => {
    const pageIndex = region.previewPages.findIndex((_, i) => pageHasBothColumns(region.selectedRegions[i]));
    const previewPage = pageIndex >= 0 ? region.previewPages[pageIndex] : undefined;
    const pageRegions = pageIndex >= 0 ? region.selectedRegions[pageIndex] : undefined;
    const itemRegion = pageRegions?.item;
    const priceRegion = pageRegions?.price;

    if (!previewPage || !itemRegion || !priceRegion) {
      setReceiptComposite(null);
      return;
    }

    let cancelled = false;
    const image = new window.Image();
    image.onload = () => {
      if (cancelled) return;
      const naturalWidth = image.naturalWidth;
      const naturalHeight = image.naturalHeight;
      const itemRect = {
        x: itemRegion.x * naturalWidth,
        y: itemRegion.y * naturalHeight,
        w: itemRegion.width * naturalWidth,
        h: itemRegion.height * naturalHeight,
      };
      const priceRect = {
        x: priceRegion.x * naturalWidth,
        y: priceRegion.y * naturalHeight,
        w: priceRegion.width * naturalWidth,
        h: priceRegion.height * naturalHeight,
      };

      const gap = 16;
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(itemRect.w + gap + priceRect.w));
      canvas.height = Math.max(1, Math.round(Math.max(itemRect.h, priceRect.h)));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#2A1214";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, itemRect.x, itemRect.y, itemRect.w, itemRect.h, 0, 0, itemRect.w, itemRect.h);
      ctx.drawImage(
        image,
        priceRect.x, priceRect.y, priceRect.w, priceRect.h,
        itemRect.w + gap, 0, priceRect.w, priceRect.h
      );
      setReceiptComposite(canvas.toDataURL("image/png"));
    };
    image.src = `data:image/png;base64,${previewPage.imageBase64}`;

    return () => {
      cancelled = true;
    };
  }, [region.previewPages, region.selectedRegions]);

  const resizeScratchCanvas = () => {
    const canvas = scratchCanvasRef.current;
    if (!canvas) return;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  };

  useEffect(() => {
    resizeScratchCanvas();
  }, [receiptComposite]);

  const clearScratchpad = () => {
    const canvas = scratchCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const scratchPointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = scratchCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const handleScratchPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    scratchDrawingRef.current = true;
    scratchLastPointRef.current = scratchPointFromEvent(event);
  };

  const handleScratchPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!scratchDrawingRef.current) return;
    const canvas = scratchCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    const point = scratchPointFromEvent(event);
    if (!canvas || !ctx || !point) return;

    const lastPoint = scratchLastPointRef.current ?? point;
    ctx.strokeStyle = "#000000";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPoint.x, lastPoint.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    scratchLastPointRef.current = point;
  };

  const stopScratchDrawing = () => {
    scratchDrawingRef.current = false;
    scratchLastPointRef.current = null;
  };

  // Locks background scroll while the fullscreen drawing overlay is open, so touch-dragging
  // near the top/bottom edge of the canvas can't also scroll the page underneath it.
  useEffect(() => {
    if (!region.isFullscreenDrawing) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [region.isFullscreenDrawing]);

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
    setTipMode("amount");
    setTipPercentInput("");
    setTipIncluded(false);
    setChosenTotal(null);
    setStep("review");
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
    // A re-scan should re-open the mismatch question rather than silently carrying over
    // whichever total was picked for a previous attempt, and should always land back on the
    // review step even if it's somehow triggered again after Continue was already clicked.
    setChosenTotal(null);
    setStep("review");
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
      // "Apply Selected Regions" is reachable from INSIDE the fullscreen overlay too (you can
      // draw boxes fullscreen and apply without ever tapping "Done" first) — without this,
      // isFullscreenDrawing could stay stuck true even once the rows step takes over, which
      // also leaves the body-scroll-lock effect's overflow:hidden stuck on indefinitely.
      region.setIsFullscreenDrawing(false);
      setTaxTotal(data.summary?.tax ?? null);
      setTipTotal(data.summary?.tip ?? null);
      setTipMode("amount");
      setTipPercentInput("");
      setTipIncluded(false);
      setReceiptTotal(data.summary?.total ?? null);
      setStatusMessage(`Found ${(data.itemRows ?? []).length} rows. Pick a category for each, then save.`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : "Could not read the receipt.");
    } finally {
      setIsApplying(false);
    }
  };

  // "totalCost" here means the row's own pre-tax/tip cost (quantity × unitCost) — the SAME
  // number shown as the black figure in the rows list, not the final total including its
  // tax/tip share (the muted "+ $x.xx" alongside it, which stays derived/non-editable since
  // it only means anything as a share of the whole receipt's tax+tip — see the allocation
  // math above). Editing it sets unitCost = entered ÷ quantity, mirroring bill-split's own
  // edit-the-total behavior; the displayed total may shift by a cent or two immediately
  // after, as the tax/tip share re-divides across the updated item costs to keep the rows
  // summing exactly to the target total — that's the allocation working as intended, not a
  // bug eating your edit.
  const updateRow = (
    id: string,
    field: "name" | "quantity" | "unitCost" | "totalCost" | "categoryId",
    value: string
  ) => {
    setRows((prev) =>
      prev.map((row) => {
        if (row.id !== id) return row;
        if (field === "name") return { ...row, name: value };
        if (field === "categoryId") return { ...row, categoryId: value };
        if (field === "quantity") {
          const quantity = Math.max(1, Math.round(Number(value) || 1));
          return { ...row, quantity };
        }
        if (field === "unitCost") return { ...row, unitCost: Math.max(0, Number(value) || 0) };
        const totalCost = Math.max(0, Number(value) || 0);
        return { ...row, unitCost: row.quantity > 0 ? totalCost / row.quantity : row.unitCost };
      })
    );
  };

  const removeRow = (id: string) => setRows((prev) => prev.filter((row) => row.id !== id));

  // Inserts a blank row at a specific position — used both by the "+" gap buttons between
  // rows (insertRowAt(index)) and the "+ Add row" button at the end (insertRowAt(rows.length)),
  // matching bill-split's insertDetectedRowAt/addDetectedRow pattern.
  const insertRowAt = (index: number) => {
    const newRow: EditableRow = { id: `manual-${Date.now()}`, name: "", quantity: 1, unitCost: 0, categoryId: "" };
    setRows((prev) => {
      const next = [...prev];
      next.splice(index, 0, newRow);
      return next;
    });
  };

  const addRow = () => insertRowAt(rows.length);

  // Pointer capture on the handle keeps pointermove/pointerup firing on it regardless of
  // where the finger/cursor ends up, so the row-under-the-pointer is found by comparing
  // clientY against each row's live position rather than relying on native dragover/drop
  // targeting (which never fires on touch devices at all).
  const handleRowPointerDown = (event: React.PointerEvent<HTMLSpanElement>, rowId: string) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraggedRowId(rowId);
    setDragOverRowId(null);
  };

  const handleRowPointerMove = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (!draggedRowId) return;
    let closestId: string | null = null;
    let closestDistance = Infinity;
    for (const row of rows) {
      const el = rowRefs.current.get(row.id);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const distance = Math.abs(event.clientY - (rect.top + rect.height / 2));
      if (distance < closestDistance) {
        closestDistance = distance;
        closestId = row.id;
      }
    }
    setDragOverRowId(closestId && closestId !== draggedRowId ? closestId : null);
  };

  const handleRowPointerUp = () => {
    setRows((prev) => {
      const fromIndex = prev.findIndex((row) => row.id === draggedRowId);
      const toIndex = prev.findIndex((row) => row.id === dragOverRowId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setDraggedRowId(null);
    setDragOverRowId(null);
  };

  const handleSave = () => {
    if (rows.length === 0 || !allRowsCategorized || !canSave) return;
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

  // Shared between the normal inline layout and the fullscreen overlay — same state, same
  // handlers, just rendered in a different container so drawing works identically in both
  // places instead of maintaining two copies of this JSX (mirrors bill-split's
  // renderRegionSelectorBody).
  const renderRegionSelectorBody = (fullscreen: boolean) => (
    <>
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
          className={`${styles.previewCanvas} ${fullscreen ? styles.previewCanvasFullscreen : ""}`}
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
          <div
            className={styles.previewZoomLayer}
            style={{ transform: `translate(${region.zoomOffset.x}px, ${region.zoomOffset.y}px) scale(${region.zoomScale})` }}
          >
            <img
              src={`data:image/png;base64,${region.activePreviewPage.imageBase64}`}
              alt={`Receipt preview — page ${region.activePage + 1}`}
              className={`${styles.previewImage} ${fullscreen ? styles.previewImageFullscreen : ""}`}
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

          {fullscreen && region.zoomScale > 1 && (
            <button
              type="button"
              className={styles.zoomResetButton}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={region.resetZoom}
            >
              {Math.round(region.zoomScale * 100)}% · Reset
            </button>
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
    </>
  );

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

      {/* step === "review", not rows.length === 0 — the selector (and its Apply button) stays
          on screen even after rows are detected, same as bill-split, so you can adjust boxes
          and re-Apply without the whole section disappearing on you. It only goes away once
          you've moved on to the categorize step, where there's nothing left to draw. */}
      {region.previewPages.length > 0 && step === "review" && (
        <div className={styles.selectorSection}>
          {region.isFullscreenDrawing ? (
            <p className={styles.fullscreenActiveHint}>Drawing in fullscreen — tap Done above to come back here.</p>
          ) : (
            <>
              <button
                type="button"
                onClick={() => region.setIsFullscreenDrawing(true)}
                className={styles.fullscreenToggleButton}
              >
                ⛶ Draw fullscreen
              </button>
              {renderRegionSelectorBody(false)}
            </>
          )}
        </div>
      )}

      {/* step === "review" as a structural guard, matching the selector above — there's
          nothing to draw fullscreen once you're on the categorize step, and this makes it
          impossible for the overlay (and its body-scroll lock) to render at all once you've
          moved on, regardless of how isFullscreenDrawing got left set. Re-applying regions
          already force-exits fullscreen on success (see applyRegions) as the primary fix for
          that; this is the structural backstop. */}
      {region.isFullscreenDrawing && step === "review" && (
        <div className={styles.fullscreenOverlay}>
          <div className={styles.fullscreenHeader}>
            <span className={styles.fullscreenHeaderTitle}>Mark Regions</span>
            <button
              type="button"
              onClick={() => region.setIsFullscreenDrawing(false)}
              className={styles.fullscreenExitButton}
            >
              ✕ Done
            </button>
          </div>
          <div className={styles.fullscreenScroll}>{renderRegionSelectorBody(true)}</div>
        </div>
      )}

      {/* Step 1: review what was scanned — names, quantities, costs, tip, and the receipt
          side-by-side — nothing about categories yet. */}
      {rows.length > 0 && step === "review" && (
        <div className={styles.rowsSection}>
          {/* Read-only figures and the one interactive control (tip) are visually split into
              two rows — cramming both into a single flex-wrap line got cluttered once tip
              editing was added. */}
          <div className={styles.summaryBar}>
            <span>Items: {formatCurrency(subtotal)}</span>
            <span>Tax + Tip: {formatCurrency(taxTip)}</span>
            {/* target, not scannedTotal — once a mismatch is resolved, this should reflect
                whichever total was actually chosen, not always the raw scanned figure. */}
            <span>Total: {formatCurrency(target)}</span>
            {/* The placeholder $0.01 from the "Scan Receipt" shortcut isn't a real prior
                amount — showing "(was $0.01)" would just be confusing noise. */}
            {!isPlaceholderAmount && (
              <span className={styles.summaryMuted}>(was {formatCurrency(expense.amount)})</span>
            )}
          </div>

          <div className={styles.tipBar}>
            <span className={styles.tipLabel}>Tip</span>
            <span className={styles.tipModeToggle}>
              <button
                type="button"
                onClick={() => switchTipMode("amount")}
                className={`${styles.tipModeButton} ${tipMode === "amount" ? styles.tipModeButtonActive : ""}`}
              >
                $
              </button>
              <button
                type="button"
                onClick={() => switchTipMode("percent")}
                className={`${styles.tipModeButton} ${tipMode === "percent" ? styles.tipModeButtonActive : ""}`}
              >
                %
              </button>
            </span>
            {tipMode === "amount" ? (
              <input
                type="number"
                min="0"
                step="0.01"
                value={tipTotal ?? 0}
                onChange={(e) => setTipTotal(Math.max(0, Number(e.target.value) || 0))}
                className={styles.tipInput}
              />
            ) : (
              <input
                type="number"
                min="0"
                step="0.1"
                value={tipPercentInput}
                onChange={(e) => setTipPercentInput(e.target.value)}
                className={styles.tipInput}
              />
            )}
            <span className={styles.summaryMuted}>({formatCurrency(effectiveTip)})</span>
            {/* Only matters when a Total was actually detected — with no detected total, the
                total is built purely from subtotal+tax+tip, so there's no double-counting
                risk to ask about in the first place. */}
            {receiptTotal !== null && (
              <span className={styles.tipIncludedToggle}>
                <button
                  type="button"
                  onClick={() => setTipIncluded(false)}
                  className={`${styles.tipModeButton} ${!tipIncluded ? styles.tipModeButtonActive : ""}`}
                >
                  Add on top of total
                </button>
                <button
                  type="button"
                  onClick={() => setTipIncluded(true)}
                  className={`${styles.tipModeButton} ${tipIncluded ? styles.tipModeButtonActive : ""}`}
                >
                  Already in total
                </button>
              </span>
            )}
          </div>

          {hasMismatch && chosenTotal === null && (
            <div className={styles.mismatchBanner}>
              <p>
                Scanned total ({formatCurrency(scannedTotal)}) doesn&apos;t match the amount you originally entered
                ({formatCurrency(expense.amount)}). Pick which one is right before continuing.
              </p>
              <div className={styles.mismatchActions}>
                <button type="button" onClick={() => setChosenTotal(scannedTotal)} className={styles.mismatchButton}>
                  Use scanned total ({formatCurrency(scannedTotal)})
                </button>
                <button type="button" onClick={() => setChosenTotal(expense.amount)} className={styles.mismatchButton}>
                  Use originally entered total ({formatCurrency(expense.amount)})
                </button>
              </div>
            </div>
          )}

          <div className={styles.rowsSplit}>
            <div className={styles.rowsPane}>
              <ol className={styles.rowsList}>
                <li className={styles.insertRowGap}>
                  <button
                    type="button"
                    className={styles.insertRowButton}
                    onClick={() => insertRowAt(0)}
                    aria-label="Insert row at top"
                  >
                    +
                  </button>
                </li>
                {rowsWithTotals.map((row, index) => (
                  <li key={row.id}>
                    <div
                      ref={(el) => {
                        if (el) rowRefs.current.set(row.id, el);
                        else rowRefs.current.delete(row.id);
                      }}
                      className={`${styles.row} ${draggedRowId === row.id ? styles.rowDragging : ""} ${
                        dragOverRowId === row.id ? styles.rowDragOver : ""
                      }`}
                    >
                      {/* Only the handle itself starts a drag — starting from an <input>
                          would just select text instead of moving the row. */}
                      <span
                        className={styles.rowDragHandle}
                        title="Drag to reorder"
                        onPointerDown={(e) => handleRowPointerDown(e, row.id)}
                        onPointerMove={handleRowPointerMove}
                        onPointerUp={handleRowPointerUp}
                        onPointerCancel={handleRowPointerUp}
                      >
                        ⠿
                      </span>
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
                        className={`${styles.rowNumber} ${styles.rowQuantity}`}
                        title="Quantity"
                      />
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.unitCost}
                        onChange={(e) => updateRow(row.id, "unitCost", e.target.value)}
                        className={`${styles.rowNumber} ${styles.rowUnitCost}`}
                        title="Cost per item"
                      />
                      <span className={styles.rowTotalGroup}>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={row.rawCost}
                          onChange={(e) => updateRow(row.id, "totalCost", e.target.value)}
                          className={styles.rowNumber}
                          title="Total cost for this item (before its share of tax/tip)"
                        />
                        {row.taxTipShare > 0.001 && (
                          <span className={styles.rowTaxShare}>+{formatCurrency(row.taxTipShare)}</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeRow(row.id)}
                        className={styles.rowRemove}
                        aria-label="Remove row"
                      >
                        ×
                      </button>
                    </div>
                    {/* A <div>, not another <li> — this gap lives INSIDE the row's own <li>,
                        as a sibling to the row's content div, so there's still exactly one
                        <li> per actual row (valid HTML — a nested <li> inside another <li>
                        isn't). Only the very first "insert at top" gap above is its own <li>,
                        since it isn't attached to any row. */}
                    <div className={styles.insertRowGap}>
                      <button
                        type="button"
                        className={styles.insertRowButton}
                        onClick={() => insertRowAt(index + 1)}
                        aria-label="Insert row here"
                      >
                        +
                      </button>
                    </div>
                  </li>
                ))}
              </ol>

              <button type="button" onClick={addRow} className={styles.secondaryButton}>
                + Add row
              </button>
            </div>

            {receiptComposite && (
              <div className={`${styles.rowsPane} ${styles.rowsStickyPane}`}>
                <div className={styles.compositeHeader}>
                  <span>Receipt</span>
                  <button type="button" onClick={clearScratchpad} className={styles.scratchpadClearButton}>
                    Clear marks
                  </button>
                </div>
                <div className={styles.scratchpadWrapper}>
                  <img
                    src={receiptComposite}
                    alt="Selected item and cost columns"
                    className={styles.compositeImage}
                    draggable={false}
                    onLoad={resizeScratchCanvas}
                  />
                  <canvas
                    ref={scratchCanvasRef}
                    className={styles.scratchpadCanvas}
                    onPointerDown={handleScratchPointerDown}
                    onPointerMove={handleScratchPointerMove}
                    onPointerUp={stopScratchDrawing}
                    onPointerLeave={stopScratchDrawing}
                    onPointerCancel={stopScratchDrawing}
                  />
                </div>
              </div>
            )}
          </div>

          <div className={styles.saveBar}>
            <button type="button" onClick={() => router.push(`/expenses/${expense.id}/edit`)} className={styles.secondaryButton}>
              Cancel
            </button>
            <button type="button" onClick={() => setStep("categorize")} disabled={!canSave} className={styles.primaryButton}>
              Continue →
            </button>
          </div>
          {!canSave && <p className={styles.hint}>Resolve the total mismatch above before continuing.</p>}
        </div>
      )}

      {/* Step 2: assign a category to each row — the scan itself is already confirmed by now,
          so this view is deliberately simpler: no receipt, no drag-reorder, just the category
          picker per row. */}
      {rows.length > 0 && step === "categorize" && (
        <div className={styles.rowsSection}>
          <div className={styles.summaryBar}>
            <span>Total: {formatCurrency(target)}</span>
          </div>

          <ol className={styles.categorizeList}>
            {rowsWithTotals.map((row) => (
              <li key={row.id} className={styles.categorizeRow}>
                <span className={styles.categorizeRowBadge}>{row.quantity}</span>
                <span className={styles.categorizeRowDetails}>
                  <strong>{row.name || "(unnamed item)"}</strong>
                  <span className={styles.categorizeRowPrice}>
                    {formatCurrency(row.unitCost)} each · {formatCurrency(row.totalCost)} total
                  </span>
                </span>
                <select
                  value={row.categoryId}
                  onChange={(e) => updateRow(row.id, "categoryId", e.target.value)}
                  className={`${styles.rowCategory} ${styles.categorizeRowCategory}`}
                >
                  <option value="">Choose category…</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ol>

          <div className={styles.saveBar}>
            <button type="button" onClick={() => setStep("review")} className={styles.secondaryButton}>
              ← Back
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!allRowsCategorized || isSaving || !canSave}
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

"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type ReceiptItem = [number, number, number];

type ReviewStorageData = {
  participants: string[];
  items: Record<string, ReceiptItem>;
  summary?: {
    total: number | null;
    tax: number | null;
    tip: number | null;
    misc: number | null;
  };
};

type ItemAssignmentMap = Record<string, string[]>;
type ItemSplitPartsMap = Record<string, Record<string, number>>;
type EditableReceiptItem = {
  id: string;
  name: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
};
type EditableSummary = {
  total: string;
  tax: string;
  tip: string;
  misc: string;
};
type TipSplitMode = "by-spending" | "evenly";
type FeeSplitMode = "by-spending" | "evenly";
type TotalMode = "includes-tip-and-tax" | "excludes-tip";
type TipInputMode = "amount" | "percent";
type PersonBreakdown = {
  itemsTotal: number;
  taxShare: number;
  miscShare: number;
  tipShare: number;
  grandTotal: number;
};
type SavedReviewPayload = ReviewStorageData & {
  assignments?: ItemAssignmentMap;
  itemRows?: EditableReceiptItem[];
  splitParts?: ItemSplitPartsMap;
  tipSplitMode?: TipSplitMode;
  feeSplitMode?: FeeSplitMode;
  totalModeOverride?: TotalMode | null;
  tipInputMode?: TipInputMode;
  tipInputValue?: string;
};

const REVIEW_STORAGE_KEY = "moneysplit-review-data";
const EVERYONE_OPTION = "Everyone";

const PERSON_COLORS = [
  "#8F3A5F",
  "#6C720C",
  "#4C5409",
  "#6B2A47",
  "#451A2D",
  "#222809",
  "#331424",
];

function getPersonColor(name: string, participants: string[]): string {
  const index = participants.indexOf(name);
  return PERSON_COLORS[index % PERSON_COLORS.length];
}

function getCardBorderColor(
  selectedNames: string[],
  effectiveAssignees: string[],
  participants: string[]
): string {
  if (effectiveAssignees.length === 0) return "#C7CE3E";
  if (selectedNames.includes(EVERYONE_OPTION)) return "#6C720C";
  return getPersonColor(effectiveAssignees[0], participants);
}

function formatCurrency(amount: number) {
  return `$${amount.toFixed(2)}`;
}

function parseNumberInput(value: string, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function buildInitialItemRows(saved: SavedReviewPayload): EditableReceiptItem[] {
  if (saved.itemRows && saved.itemRows.length > 0) return saved.itemRows;
  return Object.entries(saved.items).map(([name, [quantity, unitCost, totalCost]]) => ({
    id: name,
    name,
    quantity,
    unitCost,
    totalCost,
  }));
}

function buildItemsRecord(rows: EditableReceiptItem[]) {
  return Object.fromEntries(
    rows
      .filter((r) => r.name.trim().length > 0)
      .map((r) => [r.name.trim(), [r.quantity, r.unitCost, r.totalCost] as ReceiptItem])
  );
}

function buildInitialSummary(saved: SavedReviewPayload): EditableSummary {
  return {
    total: saved.summary?.total != null ? String(saved.summary.total) : "",
    tax: saved.summary?.tax != null ? String(saved.summary.tax) : "",
    tip: saved.summary?.tip != null ? String(saved.summary.tip) : "",
    misc: saved.summary?.misc != null ? String(saved.summary.misc) : "",
  };
}

function buildSummaryRecord(s: EditableSummary) {
  const parse = (v: string) =>
    v.trim().length > 0 ? roundCurrency(parseNumberInput(v, 0)) : null;
  return { total: parse(s.total), tax: parse(s.tax), tip: parse(s.tip), misc: parse(s.misc) };
}

function computeEffectiveTipAmount(
  summaryValues: EditableSummary,
  effectiveTotalMode: TotalMode,
  tipInputMode: TipInputMode,
  tipInputValue: string,
  itemsSubtotal: number
): number | null {
  const norm = buildSummaryRecord(summaryValues);
  const totalAmount = norm.total ?? null;
  const taxAmount = norm.tax ?? 0;
  const miscAmount = norm.misc ?? 0;

  if (tipInputValue.trim().length > 0) {
    if (tipInputMode === "percent") {
      const pct = Math.max(0, parseNumberInput(tipInputValue, 0));
      return roundCurrency(itemsSubtotal * (pct / 100));
    }
    return roundCurrency(Math.max(0, parseNumberInput(tipInputValue, 0)));
  }

  if (effectiveTotalMode === "includes-tip-and-tax" && totalAmount != null) {
    return roundCurrency(Math.max(0, totalAmount - itemsSubtotal - taxAmount - miscAmount));
  }

  return null;
}

function getEffectiveAssignees(selected: string[], participants: string[]): string[] {
  return selected.includes(EVERYONE_OPTION) ? participants : selected;
}

function getSplitRatioLabel(
  selected: string[],
  participants: string[],
  parts: Record<string, number>
): string {
  const assignees = getEffectiveAssignees(selected, participants);
  if (!assignees.length) return "";
  return assignees.map((p) => String(parts[p] ?? 1)).join(":");
}

function parseRatioDraft(draft: string, assignees: string[]): Record<string, number> {
  if (!assignees.length) return {};
  const parsed = draft
    .split(":")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => Math.max(0, parseNumberInput(p, 1)));
  return Object.fromEntries(assignees.map((name, i) => [name, parsed[i] ?? 1]));
}

function computePersonItemShare(
  item: EditableReceiptItem,
  personName: string,
  effectiveAssignees: string[],
  itemSplitParts: Record<string, number>
): number {
  if (!effectiveAssignees.includes(personName)) return 0;
  const totalParts = effectiveAssignees.reduce((s, p) => s + (itemSplitParts[p] ?? 1), 0);
  const personParts = itemSplitParts[personName] ?? 1;
  return roundCurrency(
    totalParts > 0
      ? item.totalCost * (personParts / totalParts)
      : item.totalCost / effectiveAssignees.length
  );
}

function loadSaved(): SavedReviewPayload | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(REVIEW_STORAGE_KEY);
  if (!raw) return null;
  return JSON.parse(raw) as SavedReviewPayload;
}

export default function ReviewPage() {
  const [reviewData] = useState<ReviewStorageData | null>(() => {
    const saved = loadSaved();
    if (!saved) return null;
    return { participants: saved.participants, items: saved.items, summary: saved.summary };
  });

  const [itemRows, setItemRows] = useState<EditableReceiptItem[]>(() => {
    const saved = loadSaved();
    return saved ? buildInitialItemRows(saved) : [];
  });

  const [summaryValues, setSummaryValues] = useState<EditableSummary>(() => {
    const saved = loadSaved();
    return saved ? buildInitialSummary(saved) : { total: "", tax: "", tip: "", misc: "" };
  });

  const [assignments, setAssignments] = useState<ItemAssignmentMap>(() => {
    const saved = loadSaved();
    if (!saved) return {};
    const rows = buildInitialItemRows(saved);
    return Object.fromEntries(
      rows.map((r) => [
        r.id,
        saved.assignments?.[r.id] ?? saved.assignments?.[r.name] ?? [],
      ])
    );
  });

  const [splitParts, setSplitParts] = useState<ItemSplitPartsMap>(() => {
    const saved = loadSaved();
    return saved?.splitParts ?? {};
  });

  const [ratioDrafts, setRatioDrafts] = useState<Record<string, string>>({});
  const [rowOrderDrafts, setRowOrderDrafts] = useState<Record<string, string>>({});

  const [tipSplitMode, setTipSplitMode] = useState<TipSplitMode>(() => {
    return loadSaved()?.tipSplitMode ?? "by-spending";
  });

  const [feeSplitMode, setFeeSplitMode] = useState<FeeSplitMode>(() => {
    return loadSaved()?.feeSplitMode ?? "by-spending";
  });

  const [totalModeOverride, setTotalModeOverride] = useState<TotalMode | null>(() => {
    return loadSaved()?.totalModeOverride ?? null;
  });

  const [tipInputMode, setTipInputMode] = useState<TipInputMode>(() => {
    return loadSaved()?.tipInputMode ?? "amount";
  });

  const [tipInputValue, setTipInputValue] = useState<string>(() => {
    const saved = loadSaved();
    if (!saved) return "";
    if (saved.tipInputValue != null) return saved.tipInputValue;
    return saved.summary?.tip != null ? String(saved.summary.tip) : "";
  });

  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [openPersonBreakdowns, setOpenPersonBreakdowns] = useState<Set<string>>(new Set());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showTotalModeOverride, setShowTotalModeOverride] = useState(false);

  const [draggedItemId, setDraggedItemId] = useState<string | null>(null);
  const [dragOverItemId, setDragOverItemId] = useState<string | null>(null);
  const dragCounterRef = useRef<Record<string, number>>({});

  const selectionOptions = useMemo(
    () => (reviewData ? [EVERYONE_OPTION, ...reviewData.participants] : []),
    [reviewData]
  );

  const itemsSubtotal = useMemo(
    () => roundCurrency(itemRows.reduce((s, r) => s + r.totalCost, 0)),
    [itemRows]
  );

  // Auto-detect whether the entered total includes tip or not
  const detectedTotalMode = useMemo<TotalMode | null>(() => {
    const norm = buildSummaryRecord(summaryValues);
    if (norm.total == null) return null;
    const tax = norm.tax ?? 0;
    const misc = norm.misc ?? 0;
    const base = itemsSubtotal + tax + misc;
    const threshold = Math.max(0.5, norm.total * 0.03);
    if (Math.abs(norm.total - base) < threshold) return "excludes-tip";
    if (tipInputValue.trim().length > 0) {
      const rawTip =
        tipInputMode === "percent"
          ? itemsSubtotal * (Math.max(0, parseNumberInput(tipInputValue, 0)) / 100)
          : Math.max(0, parseNumberInput(tipInputValue, 0));
      if (Math.abs(norm.total - base - rawTip) < threshold) return "includes-tip-and-tax";
    }
    return null;
  }, [summaryValues, itemsSubtotal, tipInputValue, tipInputMode]);

  const effectiveTotalMode: TotalMode =
    totalModeOverride ?? detectedTotalMode ?? "includes-tip-and-tax";

  const effectiveTipAmount = useMemo(
    () => computeEffectiveTipAmount(summaryValues, effectiveTotalMode, tipInputMode, tipInputValue, itemsSubtotal),
    [summaryValues, effectiveTotalMode, tipInputMode, tipInputValue, itemsSubtotal]
  );

  useEffect(() => {
    if (!reviewData) return;
    localStorage.setItem(
      REVIEW_STORAGE_KEY,
      JSON.stringify({
        ...reviewData,
        items: buildItemsRecord(itemRows),
        summary: { ...buildSummaryRecord(summaryValues), tip: effectiveTipAmount },
        itemRows,
        assignments,
        splitParts,
        tipSplitMode,
        feeSplitMode,
        totalModeOverride,
        tipInputMode,
        tipInputValue,
      })
    );
  }, [
    assignments,
    effectiveTipAmount,
    itemRows,
    reviewData,
    splitParts,
    summaryValues,
    tipInputMode,
    tipInputValue,
    tipSplitMode,
    feeSplitMode,
    totalModeOverride,
  ]);

  const toggleAssignment = (itemId: string, name: string) => {
    setAssignments((curr) => {
      const selected = curr[itemId] ?? [];
      if (name === EVERYONE_OPTION) {
        const next = selected.includes(EVERYONE_OPTION) ? [] : [EVERYONE_OPTION];
        setSplitParts((p) => ({
          ...p,
          [itemId]: next.length > 0 && reviewData
            ? Object.fromEntries(reviewData.participants.map((n) => [n, 1]))
            : {},
        }));
        return { ...curr, [itemId]: next };
      }
      const filtered = selected.filter((n) => n !== EVERYONE_OPTION);
      const next = filtered.includes(name)
        ? filtered.filter((n) => n !== name)
        : [...filtered, name];
      setSplitParts((p) => ({
        ...p,
        [itemId]: Object.fromEntries(
          next.map((n) => [n, p[itemId]?.[n] ?? 1])
        ),
      }));
      return { ...curr, [itemId]: next };
    });
  };

  const applyRatioDraft = (itemId: string) => {
    if (!reviewData) return;
    const selected = assignments[itemId] ?? [];
    const assignees = getEffectiveAssignees(selected, reviewData.participants);
    const draft = ratioDrafts[itemId];
    if (!draft) return;
    setSplitParts((p) => ({ ...p, [itemId]: parseRatioDraft(draft, assignees) }));
    setRatioDrafts((d) => { const n = { ...d }; delete n[itemId]; return n; });
  };

  const updateItemRow = (
    itemId: string,
    field: "name" | "quantity" | "unitCost" | "totalCost",
    value: string
  ) => {
    setItemRows((rows) =>
      rows.map((r) => {
        if (r.id !== itemId) return r;
        if (field === "name") return { ...r, name: value };
        if (field === "quantity") {
          const qty = Math.max(1, parseNumberInput(value, r.quantity));
          return { ...r, quantity: qty, totalCost: roundCurrency(qty * r.unitCost) };
        }
        if (field === "unitCost") {
          const uc = Math.max(0, parseNumberInput(value, r.unitCost));
          return { ...r, unitCost: uc, totalCost: roundCurrency(r.quantity * uc) };
        }
        const tc = Math.max(0, parseNumberInput(value, r.totalCost));
        return { ...r, totalCost: tc, unitCost: r.quantity > 0 ? roundCurrency(tc / r.quantity) : r.unitCost };
      })
    );
  };

  const moveItemRowToPosition = (itemId: string, rawPos: string) => {
    setItemRows((rows) => {
      const ci = rows.findIndex((r) => r.id === itemId);
      if (ci < 0) return rows;
      const ni = Math.min(rows.length - 1, Math.max(0, Math.round(parseNumberInput(rawPos, ci + 1)) - 1));
      if (ni === ci) return rows;
      const next = [...rows];
      const [moved] = next.splice(ci, 1);
      next.splice(ni, 0, moved);
      return next;
    });
    setRowOrderDrafts((d) => { const n = { ...d }; delete n[itemId]; return n; });
  };

  const moveToTop = (itemId: string) => moveItemRowToPosition(itemId, "1");

  const moveToBottom = (itemId: string) => {
    setItemRows((rows) => {
      const ci = rows.findIndex((r) => r.id === itemId);
      if (ci < 0 || ci === rows.length - 1) return rows;
      const next = [...rows];
      const [moved] = next.splice(ci, 1);
      next.push(moved);
      return next;
    });
  };

  const removeItemRow = (itemId: string) => {
    setItemRows((rows) => rows.filter((r) => r.id !== itemId));
    setAssignments((a) => { const n = { ...a }; delete n[itemId]; return n; });
    setSplitParts((p) => { const n = { ...p }; delete n[itemId]; return n; });
    setRatioDrafts((d) => { const n = { ...d }; delete n[itemId]; return n; });
    setExpandedCards((s) => { const n = new Set(s); n.delete(itemId); return n; });
  };

  const addItemRow = () => {
    const id = `manual-${Date.now()}`;
    setItemRows((rows) => [...rows, { id, name: "", quantity: 1, unitCost: 0, totalCost: 0 }]);
    setAssignments((a) => ({ ...a, [id]: [] }));
    setSplitParts((p) => ({ ...p, [id]: {} }));
  };

  const updateSummaryValue = (field: keyof EditableSummary, value: string) => {
    setSummaryValues((v) => ({ ...v, [field]: value }));
  };

  const handleDragStart = (e: React.DragEvent, itemId: string) => {
    setDraggedItemId(itemId);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragEnter = (itemId: string) => {
    dragCounterRef.current[itemId] = (dragCounterRef.current[itemId] ?? 0) + 1;
    setDragOverItemId(itemId);
  };
  const handleDragLeave = (itemId: string) => {
    dragCounterRef.current[itemId] = Math.max(0, (dragCounterRef.current[itemId] ?? 1) - 1);
    if (dragCounterRef.current[itemId] === 0)
      setDragOverItemId((c) => (c === itemId ? null : c));
  };
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };
  const handleDrop = (targetId: string) => {
    dragCounterRef.current = {};
    const from = draggedItemId;
    if (!from || from === targetId) { setDraggedItemId(null); setDragOverItemId(null); return; }
    setItemRows((rows) => {
      const fi = rows.findIndex((r) => r.id === from);
      const ti = rows.findIndex((r) => r.id === targetId);
      if (fi < 0 || ti < 0) return rows;
      const next = [...rows];
      const [moved] = next.splice(fi, 1);
      next.splice(ti, 0, moved);
      return next;
    });
    setDraggedItemId(null);
    setDragOverItemId(null);
  };
  const handleDragEnd = () => {
    dragCounterRef.current = {};
    setDraggedItemId(null);
    setDragOverItemId(null);
  };

  const splitResults = useMemo(() => {
    if (!reviewData) return { perPerson: {} as Record<string, PersonBreakdown>, assignedSubtotal: 0, unassignedItems: [] as string[], expectedEnteredTotal: 0, itemBreakdown: {} as Record<string, Array<{ name: string; share: number }>> };

    const perPerson = Object.fromEntries(
      reviewData.participants.map((n) => [n, { itemsTotal: 0, taxShare: 0, miscShare: 0, tipShare: 0, grandTotal: 0 }])
    ) as Record<string, PersonBreakdown>;

    const itemBreakdown: Record<string, Array<{ name: string; share: number }>> =
      Object.fromEntries(reviewData.participants.map((n) => [n, []]));

    const unassignedItems: string[] = [];

    for (const row of itemRows) {
      const itemName = row.name.trim() || "Unnamed item";
      const selected = assignments[row.id] ?? [];
      const assignees = getEffectiveAssignees(selected, reviewData.participants);
      if (!assignees.length) { unassignedItems.push(itemName); continue; }

      const parts = splitParts[row.id] ?? {};

      for (const person of assignees) {
        if (!perPerson[person]) continue;
        const share = computePersonItemShare(row, person, assignees, parts);
        perPerson[person].itemsTotal += share;
        itemBreakdown[person].push({ name: itemName, share });
      }
    }

    const assignedSubtotal = Object.values(perPerson).reduce((s, p) => s + p.itemsTotal, 0);
    const norm = buildSummaryRecord(summaryValues);
    const taxAmount = norm.tax ?? 0;
    const miscAmount = norm.misc ?? 0;
    const tipAmount = effectiveTipAmount ?? 0;
    const assignedPeople = reviewData.participants.filter((n) => perPerson[n].itemsTotal > 0);
    const evenTip = assignedPeople.length > 0 ? tipAmount / assignedPeople.length : 0;
    const evenFee = assignedPeople.length > 0 ? miscAmount / assignedPeople.length : 0;

    for (const bp of Object.values(perPerson)) {
      const ratio = assignedSubtotal > 0 ? bp.itemsTotal / assignedSubtotal : 0;
      bp.taxShare = taxAmount * ratio;
      bp.miscShare = feeSplitMode === "evenly" ? (bp.itemsTotal > 0 ? evenFee : 0) : miscAmount * ratio;
      bp.tipShare = tipSplitMode === "evenly" ? (bp.itemsTotal > 0 ? evenTip : 0) : tipAmount * ratio;
      bp.grandTotal = bp.itemsTotal + bp.taxShare + bp.miscShare + bp.tipShare;
    }

    const expectedEnteredTotal = roundCurrency(
      itemsSubtotal +
      taxAmount +
      (effectiveTotalMode === "includes-tip-and-tax" ? miscAmount + tipAmount : 0)
    );

    return { perPerson, assignedSubtotal, unassignedItems, expectedEnteredTotal, itemBreakdown };
  }, [assignments, effectiveTipAmount, effectiveTotalMode, itemRows, itemsSubtotal, reviewData, splitParts, summaryValues, tipSplitMode, feeSplitMode]);

  if (!reviewData) {
    return (
      <section
        className="mx-auto max-w-[720px] rounded-[28px] p-8"
        style={{ backgroundColor: "#2A1214", border: "1px solid #331424" }}
      >
        <h1 className="mt-2 text-[2rem] font-bold" style={{ color: "#F1E4E6" }}>
          Review Bill Items
        </h1>
        <p className="mt-4 leading-7" style={{ color: "#C9A3AF" }}>
          No bill setup data found. Add names on the first page before coming here.
        </p>
        <Link href="/" className="mt-6 inline-block font-semibold" style={{ color: "#6C720C" }}>
          ← Back to Setup
        </Link>
      </section>
    );
  }

  const norm = buildSummaryRecord(summaryValues);
  const taxAmt = norm.tax ?? 0;
  const miscAmt = norm.misc ?? 0;
  const tipAmt = effectiveTipAmount ?? 0;
  const computedForEquation = roundCurrency(
    itemsSubtotal +
    taxAmt +
    miscAmt +
    (effectiveTotalMode === "includes-tip-and-tax" ? tipAmt : 0)
  );
  const enteredTotal = norm.total;
  const reconcileDiff = enteredTotal != null ? Math.abs(enteredTotal - computedForEquation) : 0;

  return (
    <div className="w-full relative" style={{ paddingBottom: "5rem" }}>
      {/* ─── Step header ─── */}
      <div className="mb-6">
        <p className="text-[0.72rem] font-extrabold uppercase tracking-[0.22em]" style={{ color: "#6C720C" }}>
          Step 2
        </p>
        <h1 className="mt-1 text-[1.7rem] font-extrabold" style={{ color: "#F1E4E6" }}>
          Assign Each Item
        </h1>
        <p className="mt-2 max-w-[580px] text-sm leading-6" style={{ color: "#C9A3AF" }}>
          Tap a name on each card to assign it. Use{" "}
          <strong style={{ color: "#F1E4E6" }}>Everyone</strong> for shared charges.
        </p>
      </div>

      {/* ─── Summary cards ─── */}
      <div className="mb-4 grid gap-3 sm:grid-cols-2 md:grid-cols-4">
        {/* Total */}
        <div className="rounded-[18px] px-4 py-3" style={{ background: "#2A1214", border: "1.5px solid #331424" }}>
          <span className="block text-[0.68rem] font-extrabold uppercase tracking-[0.14em]" style={{ color: "#C9A3AF" }}>
            Total
          </span>
          <input
            type="number" min="0" step="0.01"
            value={summaryValues.total}
            onChange={(e) => updateSummaryValue("total", e.target.value)}
            placeholder="Enter total"
            className="mt-1.5 w-full rounded-xl px-3 py-2 text-sm font-bold"
            style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
          />
        </div>
        {/* Tax */}
        <div className="rounded-[18px] px-4 py-3" style={{ background: "#2A1214", border: "1.5px solid #331424" }}>
          <span className="block text-[0.68rem] font-extrabold uppercase tracking-[0.14em]" style={{ color: "#C9A3AF" }}>
            Tax
          </span>
          <input
            type="number" min="0" step="0.01"
            value={summaryValues.tax}
            onChange={(e) => updateSummaryValue("tax", e.target.value)}
            placeholder="Enter tax"
            className="mt-1.5 w-full rounded-xl px-3 py-2 text-sm font-bold"
            style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
          />
        </div>
        {/* Misc */}
        <div className="rounded-[18px] px-4 py-3" style={{ background: "#2A1214", border: "1.5px solid #331424" }}>
          <span className="block text-[0.68rem] font-extrabold uppercase tracking-[0.14em]" style={{ color: "#C9A3AF" }}>
            Misc / Fees
          </span>
          <input
            type="number" min="0" step="0.01"
            value={summaryValues.misc}
            onChange={(e) => updateSummaryValue("misc", e.target.value)}
            placeholder="Enter misc fees"
            className="mt-1.5 w-full rounded-xl px-3 py-2 text-sm font-bold"
            style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
          />
        </div>
        {/* Tip */}
        <div className="rounded-[18px] px-4 py-3" style={{ background: "#2A1214", border: "1.5px solid #331424" }}>
          <div className="flex items-center justify-between">
            <span className="text-[0.68rem] font-extrabold uppercase tracking-[0.14em]" style={{ color: "#C9A3AF" }}>
              {tipInputMode === "percent" ? "Tip %" : "Tip Amount"}
            </span>
            <div className="flex overflow-hidden rounded-lg" style={{ border: "1.5px solid #451A2D" }}>
              <button
                type="button"
                onClick={() => setTipInputMode("amount")}
                className="px-2 py-0.5 text-xs font-bold transition"
                style={tipInputMode === "amount"
                  ? { background: "#6C720C", color: "#0D0B02" }
                  : { background: "#2A1214", color: "#C9A3AF" }}
              >$</button>
              <button
                type="button"
                onClick={() => setTipInputMode("percent")}
                className="px-2 py-0.5 text-xs font-bold transition"
                style={tipInputMode === "percent"
                  ? { background: "#6C720C", color: "#0D0B02" }
                  : { background: "#2A1214", color: "#C9A3AF" }}
              >%</button>
            </div>
          </div>
          <input
            type="number" min="0"
            step={tipInputMode === "percent" ? "0.1" : "0.01"}
            value={tipInputValue}
            onChange={(e) => setTipInputValue(e.target.value)}
            placeholder={tipInputMode === "percent" ? "e.g. 18" : "e.g. 8.00"}
            className="mt-1.5 w-full rounded-xl px-3 py-2 text-sm font-bold"
            style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
          />
          {effectiveTipAmount != null && tipInputValue.trim() === "" && effectiveTotalMode === "includes-tip-and-tax" && (
            <p className="mt-1 text-[0.72rem] font-semibold" style={{ color: "#C9A3AF" }}>
              Derived: {formatCurrency(effectiveTipAmount)}
            </p>
          )}
          {tipInputMode === "percent" && tipInputValue.trim().length > 0 && effectiveTipAmount != null && (
            <p className="mt-1 text-[0.72rem] font-semibold" style={{ color: "#C9A3AF" }}>
              = {formatCurrency(effectiveTipAmount)}
            </p>
          )}
        </div>
      </div>

      {/* ─── Reconciliation equation ─── */}
      {enteredTotal != null && (
        <div
          className="mb-4 rounded-2xl px-5 py-3"
          style={{
            background: reconcileDiff > 0.009 ? "#3A2410" : "#16281A",
            border: `1.5px solid ${reconcileDiff > 0.009 ? "#C8791E" : "#4A7A4E"}`,
          }}
        >
          <div className="flex flex-wrap items-center gap-1.5 text-sm font-semibold" style={{ color: "#F1E4E6" }}>
            <span>Items <strong>{formatCurrency(itemsSubtotal)}</strong></span>
            {taxAmt > 0 && <><span style={{ color: "#C9A3AF" }}>+</span><span>Tax <strong>{formatCurrency(taxAmt)}</strong></span></>}
            {miscAmt > 0 && <><span style={{ color: "#C9A3AF" }}>+</span><span>Misc <strong>{formatCurrency(miscAmt)}</strong></span></>}
            {effectiveTotalMode === "includes-tip-and-tax" && tipAmt > 0 && (
              <><span style={{ color: "#C9A3AF" }}>+</span><span>Tip <strong>{formatCurrency(tipAmt)}</strong></span></>
            )}
            <span style={{ color: "#C9A3AF" }}>=</span>
            <strong>{formatCurrency(computedForEquation)}</strong>
            {reconcileDiff > 0.009 ? (
              <span style={{ color: "#E8A34D" }}>
                ≠ entered {formatCurrency(enteredTotal)} &nbsp;(Δ {formatCurrency(reconcileDiff)})
              </span>
            ) : (
              <span style={{ color: "#8FC48F" }}>✓ matches entered {formatCurrency(enteredTotal)}</span>
            )}
          </div>

          {/* Total mode detection hint */}
          <div className="mt-2 text-xs" style={{ color: "#C9A3AF" }}>
            {totalModeOverride == null && detectedTotalMode === "excludes-tip" && (
              <span>Detected: your total covers items + tax + misc. Tip is added on top.{" "}
                <button onClick={() => setShowTotalModeOverride(true)} className="underline font-bold" style={{ color: "#6C720C" }}>Change?</button>
              </span>
            )}
            {totalModeOverride == null && detectedTotalMode === "includes-tip-and-tax" && (
              <span>Detected: your total covers everything including tip.{" "}
                <button onClick={() => setShowTotalModeOverride(true)} className="underline font-bold" style={{ color: "#6C720C" }}>Change?</button>
              </span>
            )}
            {totalModeOverride == null && detectedTotalMode == null && enteredTotal != null && (
              <span>Can&apos;t auto-detect what this total covers.{" "}
                <button onClick={() => setShowTotalModeOverride(true)} className="underline font-bold" style={{ color: "#6C720C" }}>Set it manually</button>
              </span>
            )}
            {totalModeOverride != null && (
              <span>
                Using: <strong>{totalModeOverride === "includes-tip-and-tax" ? "total covers everything" : "total covers items + tax + misc"}</strong>.{" "}
                <button onClick={() => { setTotalModeOverride(null); setShowTotalModeOverride(false); }} className="underline font-bold" style={{ color: "#6C720C" }}>Reset to auto-detect</button>
              </span>
            )}
          </div>

          {/* Manual override picker */}
          {showTotalModeOverride && totalModeOverride == null && (
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => { setTotalModeOverride("includes-tip-and-tax"); setShowTotalModeOverride(false); }}
                className="rounded-xl px-3 py-1.5 text-xs font-bold"
                style={{ background: "#6C720C", color: "#0D0B02" }}
              >
                Total includes everything (tip + tax + misc)
              </button>
              <button
                onClick={() => { setTotalModeOverride("excludes-tip"); setShowTotalModeOverride(false); }}
                className="rounded-xl px-3 py-1.5 text-xs font-bold"
                style={{ background: "#6C720C", color: "#0D0B02" }}
              >
                Total includes only items + tax + misc (tip on top)
              </button>
              <button
                onClick={() => setShowTotalModeOverride(false)}
                className="rounded-xl px-3 py-1.5 text-xs font-bold"
                style={{ background: "transparent", color: "#C9A3AF", border: "1px solid #451A2D" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}

      {/* ─── Settings accordion ─── */}
      <div className="mb-5">
        <button
          type="button"
          onClick={() => setSettingsOpen((o) => !o)}
          className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold transition"
          style={{ background: settingsOpen ? "#331424" : "#2A1214", border: "1.5px solid #451A2D", color: "#F1E4E6" }}
        >
          ⚙ Split settings {settingsOpen ? "▲" : "▾"}
        </button>
        {settingsOpen && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="rounded-[16px] px-4 py-3" style={{ background: "#2A1214", border: "1.5px solid #331424" }}>
              <label className="block">
                <span className="block text-[0.68rem] font-extrabold uppercase tracking-[0.14em] mb-1.5" style={{ color: "#C9A3AF" }}>
                  Tip Split
                </span>
                <select
                  value={tipSplitMode}
                  onChange={(e) => setTipSplitMode(e.target.value as TipSplitMode)}
                  className="w-full rounded-xl px-3 py-2 text-sm font-bold"
                  style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                >
                  <option value="by-spending">By spending</option>
                  <option value="evenly">Evenly</option>
                </select>
              </label>
            </div>
            <div className="rounded-[16px] px-4 py-3" style={{ background: "#2A1214", border: "1.5px solid #331424" }}>
              <label className="block">
                <span className="block text-[0.68rem] font-extrabold uppercase tracking-[0.14em] mb-1.5" style={{ color: "#C9A3AF" }}>
                  Fee Split
                </span>
                <select
                  value={feeSplitMode}
                  onChange={(e) => setFeeSplitMode(e.target.value as FeeSplitMode)}
                  className="w-full rounded-xl px-3 py-2 text-sm font-bold"
                  style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                >
                  <option value="by-spending">By spending</option>
                  <option value="evenly">Evenly</option>
                </select>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* ─── Unassigned warning ─── */}
      {splitResults.unassignedItems.length > 0 && (
        <div className="mb-5 rounded-2xl px-5 py-4" style={{ background: "#3A2410", border: "1.5px solid #C8791E" }}>
          <p className="font-bold" style={{ color: "#E8A34D" }}>Items still need assignments</p>
          <p className="mt-1 text-sm" style={{ color: "#D9B98A" }}>
            {splitResults.unassignedItems.join(", ")}
          </p>
        </div>
      )}

      {/* ─── Two-column layout (cards + sticky panel) ─── */}
      <div className="flex gap-5 items-start">

        {/* Left: item cards */}
        <div className="flex-1 min-w-0 space-y-3">
          {itemRows.map((itemRow, index) => {
            const selected = assignments[itemRow.id] ?? [];
            const assignees = getEffectiveAssignees(selected, reviewData.participants);
            const parts = splitParts[itemRow.id] ?? {};
            const borderColor = getCardBorderColor(selected, assignees, reviewData.participants);
            const isExpanded = expandedCards.has(itemRow.id);
            const isDragTarget = dragOverItemId === itemRow.id && draggedItemId !== itemRow.id;
            const rowOrderValue = rowOrderDrafts[itemRow.id] ?? String(index + 1);
            const ratioLabel = getSplitRatioLabel(selected, reviewData.participants, parts);
            const ratioValue = ratioDrafts[itemRow.id] ?? ratioLabel;

            return (
              <div
                key={itemRow.id}
                draggable
                onDragStart={(e) => handleDragStart(e, itemRow.id)}
                onDragEnter={() => handleDragEnter(itemRow.id)}
                onDragLeave={() => handleDragLeave(itemRow.id)}
                onDragOver={handleDragOver}
                onDrop={() => handleDrop(itemRow.id)}
                onDragEnd={handleDragEnd}
                className="rounded-[20px] transition-all"
                style={{
                  background: "#2A1214",
                  border: `1.5px solid ${isDragTarget ? "#6C720C" : "#331424"}`,
                  borderLeft: `5px solid ${borderColor}`,
                  boxShadow: isDragTarget ? `0 0 0 3px rgba(108,114,12,0.15)` : "0 4px 16px rgba(7,4,3,0.06)",
                  opacity: draggedItemId === itemRow.id ? 0.4 : 1,
                }}
              >
                {/* Card body — always visible, all fields inline editable */}
                <div className="flex items-start gap-3 px-4 pt-3 pb-3">
                  {/* Drag handle */}
                  <span
                    className="cursor-grab active:cursor-grabbing select-none mt-2.5 text-lg leading-none"
                    title="Drag to reorder"
                    style={{ color: "#451A2D" }}
                  >⠿</span>

                  <div className="flex-1 min-w-0 space-y-2">
                    {/* Name + total + more button row */}
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0 truncate">
                        <span className="text-sm font-bold" style={{ color: "#F1E4E6" }}>
                          {itemRow.name || "Unnamed item"}
                        </span>
                        <span className="ml-2 text-xs font-semibold" style={{ color: "#C9A3AF" }}>
                          {formatCurrency(itemRow.totalCost)}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedCards((s) => {
                            const n = new Set(s);
                            if (n.has(itemRow.id)) {
                              n.delete(itemRow.id);
                            } else {
                              n.add(itemRow.id);
                            }
                            return n;
                          })
                        }
                        title={isExpanded ? "Collapse options" : "Edit name, cost, or order"}
                        className="rounded-xl px-2.5 py-1.5 text-xs font-bold transition shrink-0"
                        style={{
                          background: isExpanded ? "#331424" : "#2A1214",
                          border: "1.5px solid #451A2D",
                          color: "#F1E4E6",
                        }}
                      >
                        {isExpanded ? "✕" : "⋯"}
                      </button>
                    </div>

                    {/* Ratio — always visible since it's used every time you split a shared item */}
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold" style={{ color: "#C9A3AF" }}>Ratio</span>
                      <input
                        type="text"
                        value={ratioValue}
                        onChange={(e) => setRatioDrafts((d) => ({ ...d, [itemRow.id]: e.target.value }))}
                        onBlur={() => applyRatioDraft(itemRow.id)}
                        placeholder={assignees.length > 0 ? assignees.map(() => "1").join(":") : "1:1"}
                        className="rounded-lg px-2 py-1 text-xs font-bold w-20"
                        style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                      />
                    </div>

                    {/* Person pills */}
                    <div className="flex flex-wrap gap-1.5">
                      {selectionOptions.map((name) => {
                        const isAssigned = selected.includes(name);
                        const color = name === EVERYONE_OPTION ? "#A85073" : getPersonColor(name, reviewData.participants);
                        const effectivelyAssigned =
                          name !== EVERYONE_OPTION && assignees.includes(name);
                        const share = effectivelyAssigned
                          ? computePersonItemShare(itemRow, name, assignees, parts)
                          : null;

                        return (
                          <button
                            key={name}
                            type="button"
                            onClick={() => toggleAssignment(itemRow.id, name)}
                            className="rounded-full px-3 py-1 text-xs font-bold transition"
                            style={{
                              borderWidth: "1.5px",
                              borderStyle: "solid",
                              borderColor: color,
                              backgroundColor: isAssigned ? color : "transparent",
                              color: isAssigned ? "#F1E4E6" : color,
                            }}
                          >
                            {name}
                            {share != null && share > 0 && (
                              <span style={{ opacity: 0.85 }}> · {formatCurrency(share)}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Expanded: name, cost, reorder, remove — the receipt-scan page now handles most of this editing */}
                {isExpanded && (
                  <div
                    className="mx-4 mb-4 rounded-[14px] p-3 space-y-3"
                    style={{ background: "#331424", border: "1px solid #331424" }}
                  >
                    {/* Editable name */}
                    <label className="block">
                      <span className="block mb-1 text-[0.65rem] font-extrabold uppercase tracking-widest" style={{ color: "#C9A3AF" }}>Item name</span>
                      <input
                        type="text"
                        value={itemRow.name}
                        onChange={(e) => updateItemRow(itemRow.id, "name", e.target.value)}
                        placeholder="Item name"
                        className="w-full rounded-xl px-3 py-1.5 text-sm font-bold"
                        style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                      />
                    </label>

                    {/* Qty × $/item = Total row */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-bold" style={{ color: "#C9A3AF" }}>Qty</span>
                      <input
                        type="number" min="1" step="1"
                        value={itemRow.quantity}
                        onChange={(e) => updateItemRow(itemRow.id, "quantity", e.target.value)}
                        className="rounded-lg px-2 py-1 text-sm font-bold text-center w-14"
                        style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                      />
                      <span className="text-xs font-bold" style={{ color: "#C9A3AF" }}>×</span>
                      <input
                        type="number" min="0" step="0.01"
                        value={itemRow.unitCost}
                        onChange={(e) => updateItemRow(itemRow.id, "unitCost", e.target.value)}
                        className="rounded-lg px-2 py-1 text-sm font-bold text-center w-20"
                        style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                      />
                      <span className="text-xs font-bold" style={{ color: "#C9A3AF" }}>=</span>
                      <input
                        type="number" min="0" step="0.01"
                        value={itemRow.totalCost}
                        onChange={(e) => updateItemRow(itemRow.id, "totalCost", e.target.value)}
                        className="rounded-lg px-2 py-1 text-sm font-extrabold text-center w-20"
                        style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                      />
                    </div>

                    {/* Row # */}
                    <div className="flex flex-wrap gap-3 items-end">
                      <label className="block">
                        <span className="block mb-1 text-[0.65rem] font-extrabold uppercase tracking-widest" style={{ color: "#C9A3AF" }}>Row #</span>
                        <input
                          type="number" min="1" step="1"
                          value={rowOrderValue}
                          onChange={(e) => setRowOrderDrafts((d) => ({ ...d, [itemRow.id]: e.target.value }))}
                          onBlur={(e) => moveItemRowToPosition(itemRow.id, e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") moveItemRowToPosition(itemRow.id, (e.target as HTMLInputElement).value); }}
                          className="rounded-xl px-3 py-2 text-sm font-bold w-16"
                          style={{ border: "1.5px solid var(--color-input-fill)", background: "var(--color-input-fill)", color: "#F1E4E6" }}
                        />
                      </label>
                      <div className="flex gap-1.5 items-center">
                        <button type="button" onClick={() => moveToTop(itemRow.id)} disabled={index === 0}
                          title="Move to top"
                          className="rounded-lg px-2 py-1.5 text-xs font-bold transition"
                          style={{ border: "1.5px solid #451A2D", background: "#2A1214", color: "#F1E4E6", opacity: index === 0 ? 0.4 : 1 }}>↑↑</button>
                        <button type="button" onClick={() => moveToBottom(itemRow.id)} disabled={index === itemRows.length - 1}
                          title="Move to bottom"
                          className="rounded-lg px-2 py-1.5 text-xs font-bold transition"
                          style={{ border: "1.5px solid #451A2D", background: "#2A1214", color: "#F1E4E6", opacity: index === itemRows.length - 1 ? 0.4 : 1 }}>↓↓</button>
                        <button type="button" onClick={() => removeItemRow(itemRow.id)}
                          className="rounded-lg px-2.5 py-1.5 text-xs font-bold"
                          style={{ background: "#6B2A47", color: "#F1E4E6" }}>
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Add item */}
          <button
            type="button"
            onClick={addItemRow}
            className="w-full rounded-[18px] py-3 text-sm font-bold transition"
            style={{ border: "2px dashed #451A2D", background: "transparent", color: "#F1E4E6" }}
          >
            + Add Item
          </button>

          {/* ─── Per-person results ─── */}
          <div
            className="mt-6 rounded-[24px] p-5"
            style={{ background: "#2A1214", border: "1.5px solid #331424" }}
          >
            <p className="text-[0.72rem] font-extrabold uppercase tracking-[0.18em] mb-1" style={{ color: "#6C720C" }}>
              Split Results
            </p>
            <h2 className="text-[1.5rem] font-extrabold mb-4" style={{ color: "#F1E4E6" }}>
              Per-Person Share
            </h2>

            <div className="grid gap-4 sm:grid-cols-2">
              {reviewData.participants.map((name) => {
                const bp = splitResults.perPerson[name];
                const color = getPersonColor(name, reviewData.participants);
                const breakdown = splitResults.itemBreakdown[name] ?? [];
                const isOpen = openPersonBreakdowns.has(name);

                return (
                  <article
                    key={name}
                    className="rounded-[18px] p-4"
                    style={{
                      background: "#331424",
                      border: "1.5px solid #331424",
                      borderLeft: `5px solid ${color}`,
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-[1.1rem] font-extrabold" style={{ color }}>
                        {name}
                      </h3>
                      <span className="text-[1.2rem] font-extrabold" style={{ color: "#F1E4E6" }}>
                        {formatCurrency(bp.grandTotal)}
                      </span>
                    </div>

                    <div className="mt-3 space-y-1.5 text-sm" style={{ color: "#F1E4E6" }}>
                      <div className="flex justify-between">
                        <span style={{ color: "#C9A3AF" }}>Items</span>
                        <span className="font-semibold">{formatCurrency(bp.itemsTotal)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: "#C9A3AF" }}>Tax</span>
                        <span className="font-semibold">{formatCurrency(bp.taxShare)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: "#C9A3AF" }}>Misc</span>
                        <span className="font-semibold">{formatCurrency(bp.miscShare)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span style={{ color: "#C9A3AF" }}>Tip</span>
                        <span className="font-semibold">{formatCurrency(bp.tipShare)}</span>
                      </div>
                      <div
                        className="flex justify-between pt-1.5 font-extrabold"
                        style={{ borderTop: "1.5px solid #331424", color: "#F1E4E6" }}
                      >
                        <span>Total Owed</span>
                        <span>{formatCurrency(bp.grandTotal)}</span>
                      </div>
                    </div>

                    {/* Item breakdown toggle */}
                    {breakdown.length > 0 && (
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() =>
                            setOpenPersonBreakdowns((s) => {
                              const n = new Set(s);
                              if (n.has(name)) {
                                n.delete(name);
                              } else {
                                n.add(name);
                              }
                              return n;
                            })
                          }
                          className="text-xs font-bold"
                          style={{ color: "#6C720C" }}
                        >
                          {isOpen ? "Hide items ▲" : `Show ${breakdown.length} item${breakdown.length !== 1 ? "s" : ""} ▾`}
                        </button>
                        {isOpen && (
                          <ul className="mt-2 space-y-1">
                            {breakdown.map((entry, i) => (
                              <li key={i} className="flex justify-between text-xs" style={{ color: "#F1E4E6" }}>
                                <span className="truncate pr-2" style={{ color: "#C9A3AF" }}>{entry.name}</span>
                                <span className="font-semibold shrink-0">{formatCurrency(entry.share)}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          </div>

          <Link href="/" className="mt-6 inline-block text-sm font-bold" style={{ color: "#6C720C" }}>
            ← Back to Setup
          </Link>
        </div>

        {/* ─── Sticky sidebar (desktop) ─── */}
        <div className="hidden lg:block w-56 shrink-0">
          <div
            className="sticky top-6 rounded-[20px] p-4"
            style={{ background: "#13110E", border: "2px solid #451A2D" }}
          >
            <p
              className="text-[0.65rem] font-extrabold uppercase tracking-[0.2em] mb-3"
              style={{ color: "#451A2D" }}
            >
              Running Total
            </p>
            <div className="space-y-2.5">
              {reviewData.participants.map((name) => {
                const bp = splitResults.perPerson[name];
                const color = getPersonColor(name, reviewData.participants);
                return (
                  <div key={name} className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span
                        className="text-sm font-semibold truncate"
                        style={{ color: "#F1E4E6" }}
                      >
                        {name}
                      </span>
                    </div>
                    <span className="text-sm font-extrabold shrink-0" style={{ color: "#F1E4E6" }}>
                      {formatCurrency(bp.grandTotal)}
                    </span>
                  </div>
                );
              })}
            </div>
            <div
              className="mt-3 pt-3 flex items-center justify-between"
              style={{ borderTop: "1px solid #451A2D" }}
            >
              <span className="text-xs font-bold" style={{ color: "#451A2D" }}>Grand total</span>
              <span className="text-sm font-extrabold" style={{ color: "#F1E4E6" }}>
                {formatCurrency(
                  Object.values(splitResults.perPerson).reduce((s, b) => s + b.grandTotal, 0)
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Mobile sticky bottom bar ─── */}
      <div
        className="lg:hidden fixed bottom-0 left-0 right-0 z-50"
        style={{
          background: "#13110E",
          borderTop: "2px solid #451A2D",
        }}
      >
        <div className="flex overflow-x-auto gap-5 px-5 py-2.5">
          {reviewData.participants.map((name) => {
            const bp = splitResults.perPerson[name];
            const color = getPersonColor(name, reviewData.participants);
            return (
              <div key={name} className="shrink-0 text-center">
                <div className="flex items-center gap-1 justify-center">
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-[0.68rem] font-semibold" style={{ color: "#F1E4E6", opacity: 0.8 }}>
                    {name}
                  </span>
                </div>
                <div className="text-sm font-extrabold" style={{ color: "#F1E4E6" }}>
                  {formatCurrency(bp.grandTotal)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

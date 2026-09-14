"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";

type Participant = {
  id: number;
  name: string;
};

type PreviewPage = {
  imageBase64: string;
  width: number;
  height: number;
};

type PdfReadResponse = {
  error?: string;
  text: string;
  lines: string[];
  source?: "text-layer" | "ocr" | "selected-columns";
  itemRows?: {
    id: string;
    name: string;
    quantity: number;
    unitCost: number;
    totalCost: number;
  }[];
  summary?: {
    total: number | null;
    tax: number | null;
    tip: number | null;
    misc?: number | null;
  };
  preview?: {
    pageCount: number;
    pages: PreviewPage[];
  };
};

type NormalizedRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type RegionPayloadEntry = NormalizedRegion & {
  target: SelectionTarget;
  page: number;
};

type DraftBox = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type ResizeHandle = "nw" | "ne" | "sw" | "se";

type BoxInteraction = {
  target: SelectionTarget;
  mode: "move" | "resize";
  handle?: ResizeHandle;
  startX: number;
  startY: number;
  originalRegion: NormalizedRegion;
};

type SelectionTarget =
  | "item"
  | "price"
  | "tax"
  | "tip"
  | "fees"
  | "misc"
  | "total";

// Regions are scoped per PDF page, since a receipt's item list can span multiple pages
// and its tax/tip/total can live on whichever page actually shows them.
type PageRegions = Record<SelectionTarget, NormalizedRegion | null>;
type SelectedRegionsByPage = Record<number, PageRegions>;

const SELECTION_OPTIONS: {
  key: SelectionTarget;
  label: string;
  color: string;
}[] = [
  { key: "item", label: "Item Column", color: "#8F3A5F" },
  { key: "price", label: "Cost Column", color: "#8C9410" },
  { key: "tax", label: "Tax", color: "#6B2A47" },
  { key: "tip", label: "Tip", color: "#A9B01A" },
  { key: "fees", label: "Fees", color: "#4C5409" },
  { key: "misc", label: "Misc", color: "#222809" },
  { key: "total", label: "Total", color: "#C7CE3E" },
];

const GUIDED_STEPS: {
  target: SelectionTarget;
  label: string;
  description: string;
  required: boolean;
}[] = [
  {
    target: "item",
    label: "Item names column",
    description: "Draw a box around the column that lists item names.",
    required: true,
  },
  {
    target: "price",
    label: "Prices column",
    description: "Draw a box around the column with the item prices.",
    required: true,
  },
  {
    target: "tax",
    label: "Tax amount",
    description: "Draw a tight box around just the tax dollar amount.",
    required: false,
  },
  {
    target: "tip",
    label: "Tip amount",
    description: "Draw a tight box around just the tip dollar amount.",
    required: false,
  },
  {
    target: "fees",
    label: "Fees",
    description: "Draw a box around any additional service fees.",
    required: false,
  },
  {
    target: "misc",
    label: "Misc / other charges",
    description: "Draw a box around any miscellaneous charges.",
    required: false,
  },
  {
    target: "total",
    label: "Grand total",
    description: "Draw a tight box around the grand total amount.",
    required: false,
  },
];

const EMPTY_PAGE_REGIONS: PageRegions = {
  item: null,
  price: null,
  tax: null,
  tip: null,
  fees: null,
  misc: null,
  total: null,
};

const REVIEW_STORAGE_KEY = "moneysplit-review-data";

// Next.js inlines NEXT_PUBLIC_* vars at build time, so this must be set in Vercel's
// project settings (not just locally) for production builds to reach the real backend.
const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:5001").replace(/\/+$/, "");

const SUPPORTED_RECEIPT_EXTENSIONS = [".pdf", ".heic", ".heif", ".jpg", ".jpeg", ".png"];

function isSupportedReceiptFile(filename: string) {
  const lower = filename.toLowerCase();
  return SUPPORTED_RECEIPT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function buildRegionsPayload(selectedRegions: SelectedRegionsByPage): RegionPayloadEntry[] {
  const payload: RegionPayloadEntry[] = [];
  for (const [pageKey, pageRegions] of Object.entries(selectedRegions)) {
    const page = Number(pageKey);
    for (const option of SELECTION_OPTIONS) {
      const region = pageRegions[option.key];
      if (region) payload.push({ target: option.key, page, ...region });
    }
  }
  return payload;
}

function pageHasBothColumns(pageRegions: PageRegions | undefined) {
  return Boolean(pageRegions?.item && pageRegions?.price);
}

type DetectedRow = NonNullable<PdfReadResponse["itemRows"]>[number];
type DetectedRowField = "name" | "quantity" | "unitCost" | "totalCost";

function parseNumberInput(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

export default function Home() {
  const router = useRouter();
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Pinch-to-zoom (fullscreen drawing mode only) — tracks active touches by pointerId so a
  // second finger touching down is recognized as "start pinching" regardless of where the
  // first finger's drag started (main canvas, an existing box, or a resize handle).
  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchStateRef = useRef<{
    startDistance: number;
    startScale: number;
    startOffset: { x: number; y: number };
    startMidpoint: { x: number; y: number };
  } | null>(null);

  const [participants, setParticipants] = useState<Participant[]>([
    { id: 1, name: "" },
  ]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [pdfText, setPdfText] = useState("");
  const [pdfLines, setPdfLines] = useState<string[]>([]);
  const [itemRows, setItemRows] = useState<PdfReadResponse["itemRows"]>([]);
  const [receiptSummary, setReceiptSummary] = useState<PdfReadResponse["summary"]>({
    total: null,
    tax: null,
    tip: null,
  });
  const [previewPages, setPreviewPages] = useState<PreviewPage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selectedRegions, setSelectedRegions] = useState<SelectedRegionsByPage>({});
  const [selectionTarget, setSelectionTarget] = useState<SelectionTarget>("item");
  const [draftBox, setDraftBox] = useState<DraftBox | null>(null);
  const [boxInteraction, setBoxInteraction] = useState<BoxInteraction | null>(null);
  const [scanSource, setScanSource] = useState<"text-layer" | "ocr" | "selected-columns" | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isReadingPdf, setIsReadingPdf] = useState(false);
  const [isApplyingSelection, setIsApplyingSelection] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [guidedStep, setGuidedStep] = useState<number | null>(null);
  const [showRawText, setShowRawText] = useState(false);
  const [isFullscreenDrawing, setIsFullscreenDrawing] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });

  const [isEditingRows, setIsEditingRows] = useState(false);
  const [draggedRowId, setDraggedRowId] = useState<string | null>(null);
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [receiptPanePage, setReceiptPanePage] = useState(0);
  const [receiptComposite, setReceiptComposite] = useState<string | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchDrawingRef = useRef(false);
  const scratchLastPointRef = useRef<{ x: number; y: number } | null>(null);

  const activePageRegions = selectedRegions[activePage] ?? EMPTY_PAGE_REGIONS;
  const activePreviewPage = previewPages[activePage] ?? null;
  const hasCompletePage = Object.values(selectedRegions).some(pageHasBothColumns);

  // Only pages where both the item and price columns were actually marked have anything to compose.
  const completeReceiptPages = previewPages
    .map((_, pageIndex) => pageIndex)
    .filter((pageIndex) => pageHasBothColumns(selectedRegions[pageIndex]));
  const effectiveReceiptPage = completeReceiptPages.includes(receiptPanePage)
    ? receiptPanePage
    : completeReceiptPages[0] ?? 0;

  const addParticipant = () => {
    setParticipants((prev) => [...prev, { id: Date.now(), name: "" }]);
  };

  const removeParticipant = (id: number) => {
    setParticipants((prev) => prev.filter((p) => p.id !== id));
  };

  const updateParticipantName = (id: number, name: string) => {
    setParticipants((prev) =>
      prev.map((p) => (p.id === id ? { ...p, name } : p))
    );
  };

  const participantNames = participants
    .map((p) => p.name.trim())
    .filter((n) => n.length > 0);
  const canContinue = participantNames.length > 0 && (itemRows?.length ?? 0) > 0;

  const processPdf = async (file: File, regionsPayload?: RegionPayloadEntry[]) => {
    const isApplying = Boolean(regionsPayload && regionsPayload.length > 0);

    setStatusMessage(
      isApplying
        ? "Applying your selected receipt regions…"
        : "Preparing your receipt preview…"
    );
    setScanSource(null);

    const formData = new FormData();
    formData.append("file", file);
    if (isApplying) formData.append("regions", JSON.stringify(regionsPayload));

    try {
      const response = await fetch(`${BACKEND_URL}/read-pdf`, {
        method: "POST",
        body: formData,
      });
      const data: PdfReadResponse = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not read the receipt.");

      setPdfText(data.text);
      setPdfLines(data.lines);
      setItemRows(data.itemRows ?? []);
      setReceiptSummary(data.summary ?? { total: null, tax: null, tip: null });
      setPreviewPages(data.preview?.pages ?? []);
      setScanSource(data.source ?? null);

      const pageCount = data.preview?.pageCount ?? 1;
      const pageNote = pageCount > 1 ? ` (${pageCount} pages)` : "";
      setStatusMessage(
        isApplying
          ? `Done — found ${(data.itemRows ?? []).length} rows. Draw more boxes or click Apply to re-scan.`
          : `Preview ready for ${file.name}${pageNote}. Use guided setup or draw boxes manually, then click Apply.`
      );
    } catch (error) {
      setPdfText("");
      setPdfLines([]);
      setItemRows([]);
      setPreviewPages([]);
      setReceiptSummary({ total: null, tax: null, tip: null });
      setScanSource(null);
      setStatusMessage(
        error instanceof TypeError
          ? process.env.NEXT_PUBLIC_BACKEND_URL
            ? "Could not reach the backend. It may be waking up from sleep — try again in a moment."
            : "Could not reach the backend. Start it with `python3 app.py` in the backend folder."
          : error instanceof Error
          ? error.message
          : "Could not read the receipt."
      );
    }
  };

  const handleFileSelected = async (file: File) => {
    setSelectedFile(file);
    setUploadedFileName(file.name);
    setSelectedRegions({});
    setActivePage(0);
    setSelectionTarget("item");
    setDraftBox(null);
    setBoxInteraction(null);
    setPreviewPages([]);
    setGuidedStep(null);
    setItemRows([]);
    setReceiptSummary({ total: null, tax: null, tip: null });
    setIsReadingPdf(true);
    try {
      await processPdf(file);
    } finally {
      setIsReadingPdf(false);
    }
  };

  const handleFileInputChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!isSupportedReceiptFile(file.name)) {
      setStatusMessage("Only PDF, HEIC, JPG, and PNG files are supported.");
      return;
    }
    await handleFileSelected(file);
  };

  const handleDropZoneDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(true);
  };

  const handleDropZoneDragLeave = () => setIsDragOver(false);

  const handleDropZoneDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!isSupportedReceiptFile(file.name)) {
      setStatusMessage("Only PDF, HEIC, JPG, and PNG files are supported.");
      return;
    }
    await handleFileSelected(file);
  };

  const switchToPage = (pageIndex: number) => {
    setActivePage(pageIndex);
    setDraftBox(null);
    setBoxInteraction(null);
  };

  const startGuidedMode = () => {
    setGuidedStep(0);
    setSelectionTarget(GUIDED_STEPS[0].target);
  };

  const advanceGuidedStep = () => {
    setGuidedStep((current) => {
      if (current === null) return null;
      const next = current + 1;
      if (next >= GUIDED_STEPS.length) {
        setStatusMessage("All regions marked! Click Apply Selected Regions when ready.");
        return null;
      }
      setSelectionTarget(GUIDED_STEPS[next].target);
      return next;
    });
  };

  // Converts a screen point to the canvas's own unscaled coordinate space — i.e. undoes the
  // pinch-zoom transform (translate then scale) so drawing/moving/resizing math never needs
  // to know whether the user is currently zoomed in. Outside fullscreen, zoomScale is always
  // 1 and zoomOffset always {0,0}, so this is equivalent to the old plain `clientX - rect.left`.
  const toLocalPoint = (clientX: number, clientY: number, rect: DOMRect) => ({
    x: (clientX - rect.left - zoomOffset.x) / zoomScale,
    y: (clientY - rect.top - zoomOffset.y) / zoomScale,
  });

  // Registers a touch/pointer in the fullscreen pinch tracker. Returns true if this pointer
  // just became the second (or later) active finger — callers should abandon whatever
  // single-finger interaction (drawing, moving, resizing) they were about to start, since a
  // pinch has begun instead.
  const registerFullscreenPointer = (event: React.PointerEvent): boolean => {
    if (!isFullscreenDrawing) return false;
    activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointersRef.current.size === 2) {
      const [a, b] = Array.from(activePointersRef.current.values());
      pinchStateRef.current = {
        startDistance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        startScale: zoomScale,
        startOffset: zoomOffset,
        startMidpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
      setDraftBox(null);
      setBoxInteraction(null);
      return true;
    }
    return activePointersRef.current.size > 2;
  };

  // Releases a bookkeeping-only fullscreen pointer (up/cancel/leave). Returns true while a
  // multi-touch gesture is still in progress with at least one finger down, so callers can
  // skip their normal single-finger "commit" logic (e.g. dropping a drawn box).
  const releaseFullscreenPointer = (pointerId: number): boolean => {
    if (!isFullscreenDrawing) return false;
    activePointersRef.current.delete(pointerId);
    if (activePointersRef.current.size < 2) pinchStateRef.current = null;
    return activePointersRef.current.size > 0;
  };

  const handlePreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!previewContainerRef.current) return;
    event.preventDefault();
    const rect = previewContainerRef.current.getBoundingClientRect();
    if (registerFullscreenPointer(event)) return;
    const { x: startX, y: startY } = toLocalPoint(event.clientX, event.clientY, rect);
    setDraftBox({ startX, startY, currentX: startX, currentY: startY });
  };

  const handlePreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!previewContainerRef.current) return;
    const rect = previewContainerRef.current.getBoundingClientRect();

    if (isFullscreenDrawing && activePointersRef.current.has(event.pointerId)) {
      activePointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (isFullscreenDrawing && pinchStateRef.current && activePointersRef.current.size === 2) {
      const [a, b] = Array.from(activePointersRef.current.values());
      const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const pinch = pinchStateRef.current;
      const newScale = clamp(pinch.startScale * (distance / pinch.startDistance), 1, 4);

      // Keep whatever local point was originally under the fingers anchored under them as
      // scale changes, and pan by however much the midpoint itself has moved since — this is
      // what makes the zoom feel like it's happening "at your fingers" instead of the corner.
      const anchorX = (pinch.startMidpoint.x - rect.left - pinch.startOffset.x) / pinch.startScale;
      const anchorY = (pinch.startMidpoint.y - rect.top - pinch.startOffset.y) / pinch.startScale;
      const minOffsetX = rect.width * (1 - newScale);
      const minOffsetY = rect.height * (1 - newScale);
      setZoomScale(newScale);
      setZoomOffset({
        x: clamp(midpoint.x - rect.left - anchorX * newScale, minOffsetX, 0),
        y: clamp(midpoint.y - rect.top - anchorY * newScale, minOffsetY, 0),
      });
      return;
    }

    const local = toLocalPoint(event.clientX, event.clientY, rect);
    const currentX = clamp(local.x, 0, rect.width);
    const currentY = clamp(local.y, 0, rect.height);

    if (boxInteraction) {
      const deltaX = (currentX - boxInteraction.startX) / rect.width;
      const deltaY = (currentY - boxInteraction.startY) / rect.height;
      const orig = boxInteraction.originalRegion;

      setSelectedRegions((prev) => {
        const pageRegions = prev[activePage] ?? EMPTY_PAGE_REGIONS;
        let next = { ...orig };
        if (boxInteraction.mode === "move") {
          next = {
            ...next,
            x: clamp(orig.x + deltaX, 0, 1 - orig.width),
            y: clamp(orig.y + deltaY, 0, 1 - orig.height),
          };
        } else if (boxInteraction.handle) {
          const minSize = 0.02;
          let left = orig.x, top = orig.y;
          let right = orig.x + orig.width, bottom = orig.y + orig.height;
          if (boxInteraction.handle.includes("w")) left = clamp(orig.x + deltaX, 0, right - minSize);
          if (boxInteraction.handle.includes("e")) right = clamp(right + deltaX, left + minSize, 1);
          if (boxInteraction.handle.includes("n")) top = clamp(orig.y + deltaY, 0, bottom - minSize);
          if (boxInteraction.handle.includes("s")) bottom = clamp(bottom + deltaY, top + minSize, 1);
          next = { x: left, y: top, width: right - left, height: bottom - top };
        }
        return { ...prev, [activePage]: { ...pageRegions, [boxInteraction.target]: next } };
      });
      return;
    }

    if (!draftBox) return;
    setDraftBox((prev) => prev ? { ...prev, currentX, currentY } : null);
  };

  const handlePreviewPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (releaseFullscreenPointer(event.pointerId)) return;

    if (boxInteraction) {
      setBoxInteraction(null);
      return;
    }
    if (!draftBox || !previewContainerRef.current) {
      setDraftBox(null);
      return;
    }

    const rect = previewContainerRef.current.getBoundingClientRect();
    const left = Math.min(draftBox.startX, draftBox.currentX);
    const top = Math.min(draftBox.startY, draftBox.currentY);
    const width = Math.abs(draftBox.currentX - draftBox.startX);
    const height = Math.abs(draftBox.currentY - draftBox.startY);

    if (width < 10 || height < 10) {
      setDraftBox(null);
      return;
    }

    const region: NormalizedRegion = {
      x: left / rect.width,
      y: top / rect.height,
      width: width / rect.width,
      height: height / rect.height,
    };
    const label = SELECTION_OPTIONS.find((o) => o.key === selectionTarget)?.label ?? "Selection";
    setSelectedRegions((prev) => ({
      ...prev,
      [activePage]: { ...(prev[activePage] ?? EMPTY_PAGE_REGIONS), [selectionTarget]: region },
    }));
    setDraftBox(null);

    if (guidedStep !== null) {
      advanceGuidedStep();
    } else {
      setStatusMessage(`${label} selected on page ${activePage + 1}. Keep labeling, then click Apply.`);
    }
  };

  const handleBoxPointerDown = (event: React.PointerEvent<HTMLDivElement>, target: SelectionTarget) => {
    event.stopPropagation();
    event.preventDefault();
    if (!previewContainerRef.current || !activePageRegions[target]) return;
    const rect = previewContainerRef.current.getBoundingClientRect();
    if (registerFullscreenPointer(event)) return;
    const { x: startX, y: startY } = toLocalPoint(event.clientX, event.clientY, rect);
    setSelectionTarget(target);
    setDraftBox(null);
    setBoxInteraction({
      target,
      mode: "move",
      startX,
      startY,
      originalRegion: activePageRegions[target]!,
    });
    const label = SELECTION_OPTIONS.find((o) => o.key === target)?.label ?? "Selection";
    setStatusMessage(`Adjusting ${label}. Drag to move, drag a corner to resize.`);
  };

  const handleResizePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    target: SelectionTarget,
    handle: ResizeHandle
  ) => {
    event.stopPropagation();
    event.preventDefault();
    if (!previewContainerRef.current || !activePageRegions[target]) return;
    const rect = previewContainerRef.current.getBoundingClientRect();
    if (registerFullscreenPointer(event)) return;
    const { x: startX, y: startY } = toLocalPoint(event.clientX, event.clientY, rect);
    setSelectionTarget(target);
    setDraftBox(null);
    setBoxInteraction({
      target,
      mode: "resize",
      handle,
      startX,
      startY,
      originalRegion: activePageRegions[target]!,
    });
  };

  const applySelectedColumns = async () => {
    if (!selectedFile || !hasCompletePage) return;
    setIsApplyingSelection(true);
    try {
      await processPdf(selectedFile, buildRegionsPayload(selectedRegions));
    } finally {
      setIsApplyingSelection(false);
    }
  };

  const updateDetectedRow = (rowId: string, field: DetectedRowField, value: string) => {
    setItemRows((rows) =>
      (rows ?? []).map((row) => {
        if (row.id !== rowId) return row;
        if (field === "name") return { ...row, name: value };
        if (field === "quantity") {
          const quantity = Math.max(1, Math.round(parseNumberInput(value, row.quantity)));
          return { ...row, quantity, totalCost: roundCurrency(quantity * row.unitCost) };
        }
        if (field === "unitCost") {
          const unitCost = Math.max(0, parseNumberInput(value, row.unitCost));
          return { ...row, unitCost, totalCost: roundCurrency(row.quantity * unitCost) };
        }
        const totalCost = Math.max(0, parseNumberInput(value, row.totalCost));
        return {
          ...row,
          totalCost,
          unitCost: row.quantity > 0 ? roundCurrency(totalCost / row.quantity) : row.unitCost,
        };
      })
    );
  };

  const removeDetectedRow = (rowId: string) => {
    setItemRows((rows) => (rows ?? []).filter((row) => row.id !== rowId));
  };

  const insertDetectedRowAt = (index: number) => {
    const newRow: DetectedRow = {
      id: `manual-${Date.now()}`,
      name: "",
      quantity: 1,
      unitCost: 0,
      totalCost: 0,
    };
    setItemRows((rows) => {
      const next = [...(rows ?? [])];
      next.splice(index, 0, newRow);
      return next;
    });
  };

  const addDetectedRow = () => insertDetectedRowAt(itemRows?.length ?? 0);

  // Native HTML5 drag-and-drop (draggable/onDragStart/onDrop) never fires on touch devices
  // at all, so reordering rows is built on Pointer Events instead — same unification trick
  // as the receipt box-drawing. Pointer capture on the handle is what makes this work: it
  // keeps pointermove/pointerup firing on the handle regardless of where the finger/cursor
  // physically ends up, so the row-under-the-pointer has to be found by comparing clientY
  // against each row's live position rather than relying on native dragover/drop targeting.
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
    for (const row of itemRows ?? []) {
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
    setItemRows((rows) => {
      const list = rows ?? [];
      const fromIndex = list.findIndex((row) => row.id === draggedRowId);
      const toIndex = list.findIndex((row) => row.id === dragOverRowId);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return rows;
      const next = [...list];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setDraggedRowId(null);
    setDragOverRowId(null);
  };

  const clearScratchpad = () => {
    const canvas = scratchCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  };

  const resizeScratchCanvas = () => {
    const canvas = scratchCanvasRef.current;
    if (!canvas) return;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  };

  // Lock background scroll while the fullscreen drawing overlay is open, so touch-dragging
  // near the top/bottom edge of the canvas can't also scroll the page underneath it.
  useEffect(() => {
    if (!isFullscreenDrawing) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullscreenDrawing]);

  // Reset pinch-zoom whenever fullscreen mode is entered or exited, so it never opens
  // already zoomed/panned from a previous session, and the normal (non-fullscreen) canvas
  // never sees a non-identity transform.
  useEffect(() => {
    setZoomScale(1);
    setZoomOffset({ x: 0, y: 0 });
    activePointersRef.current.clear();
    pinchStateRef.current = null;
  }, [isFullscreenDrawing]);

  // Build a side-by-side crop of just the item-name and price columns the user marked,
  // rather than showing the whole receipt page — that's what stays visible while editing rows.
  useEffect(() => {
    const previewPage = previewPages[effectiveReceiptPage];
    const pageRegions = selectedRegions[effectiveReceiptPage];
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
  }, [effectiveReceiptPage, previewPages, selectedRegions]);

  useEffect(() => {
    resizeScratchCanvas();
  }, [receiptComposite]);

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

  const handleNext = () => {
    if (!canContinue) return;
    localStorage.setItem(
      REVIEW_STORAGE_KEY,
      JSON.stringify({
        participants: participantNames,
        items: {},
        itemRows: itemRows ?? [],
        summary: receiptSummary,
        text: pdfText,
        pdfLines,
        scanSource,
      })
    );
    router.push("/review");
  };

  // Shared between the normal inline layout and the mobile fullscreen overlay — same state,
  // same handlers, just rendered in a different container so drawing works identically in
  // both places instead of maintaining two copies of this logic.
  const renderRegionSelectorBody = (fullscreen: boolean) => (
    <>
      {/* Page switcher — only shown for multi-page PDFs */}
      {previewPages.length > 1 && (
        <div className={styles.selectionControls}>
          {previewPages.map((_, pageIndex) => {
            const pageRegions = selectedRegions[pageIndex];
            const hasAnyRegion = pageRegions && Object.values(pageRegions).some(Boolean);
            return (
              <button
                key={pageIndex}
                type="button"
                onClick={() => switchToPage(pageIndex)}
                className={`${styles.selectionModeButton} ${
                  activePage === pageIndex ? styles.selectionModeButtonActive : ""
                }`}
              >
                Page {pageIndex + 1}{hasAnyRegion ? " ✓" : ""}
              </button>
            );
          })}
        </div>
      )}

      {/* Guided mode banner */}
      {guidedStep !== null ? (
        <div className={styles.guidedBanner}>
          <p className={styles.guidedProgress}>
            Step {guidedStep + 1} of {GUIDED_STEPS.length}
            {!GUIDED_STEPS[guidedStep].required && " · optional"}
          </p>
          <h4 className={styles.guidedTitle}>
            Draw: {GUIDED_STEPS[guidedStep].label}
            {previewPages.length > 1 ? ` (page ${activePage + 1})` : ""}
          </h4>
          <p className={styles.guidedDescription}>
            {GUIDED_STEPS[guidedStep].description}
          </p>
          <div className={styles.guidedActions}>
            {!GUIDED_STEPS[guidedStep].required && (
              <button
                type="button"
                onClick={advanceGuidedStep}
                className={styles.guidedSkipButton}
              >
                Skip this step ▶
              </button>
            )}
            <button
              type="button"
              onClick={() => setGuidedStep(null)}
              className={styles.guidedExitButton}
            >
              Exit guided mode
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startGuidedMode}
          className={styles.startGuidedButton}
        >
          ✦ Start guided setup
        </button>
      )}

      {/* Manual mode toolbar (hidden during guided steps) */}
      {guidedStep === null && (
        <div className={styles.selectionControls}>
          {SELECTION_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setSelectionTarget(option.key)}
              className={`${styles.selectionModeButton} ${
                selectionTarget === option.key ? styles.selectionModeButtonActive : ""
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}

      {/* Legend — reflects the currently active page */}
      <div className={styles.selectionLegend}>
        {SELECTION_OPTIONS.map((option) => (
          <span key={option.key} className={styles.selectionLegendItem}>
            <span
              className={styles.selectionSwatch}
              style={{ background: option.color }}
            />
            {option.label}{" "}
            {activePageRegions[option.key] ? (
              <strong style={{ color: option.color }}>✓</strong>
            ) : (
              <span style={{ opacity: 0.5 }}>—</span>
            )}
          </span>
        ))}
      </div>

      {/* Canvas */}
      {activePreviewPage && (
        <div
          ref={previewContainerRef}
          className={`${styles.previewCanvas} ${fullscreen ? styles.previewCanvasFullscreen : ""}`}
          onPointerDown={handlePreviewPointerDown}
          onPointerMove={handlePreviewPointerMove}
          onPointerUp={handlePreviewPointerUp}
          onPointerCancel={(event) => {
            releaseFullscreenPointer(event.pointerId);
            setDraftBox(null);
            setBoxInteraction(null);
          }}
          onPointerLeave={(event) => {
            releaseFullscreenPointer(event.pointerId);
            setDraftBox(null);
            setBoxInteraction(null);
          }}
        >
          <div
            className={styles.previewZoomLayer}
            style={{ transform: `translate(${zoomOffset.x}px, ${zoomOffset.y}px) scale(${zoomScale})` }}
          >
            <img
              src={`data:image/png;base64,${activePreviewPage.imageBase64}`}
              alt={`Receipt preview — page ${activePage + 1}`}
              className={`${styles.previewImage} ${fullscreen ? styles.previewImageFullscreen : ""}`}
              draggable={false}
            />

            {SELECTION_OPTIONS.map((option) => {
              const region = activePageRegions[option.key];
              if (!region) return null;
              return (
                <div
                  key={option.key}
                  className={`${styles.selectedBox} ${
                    selectionTarget === option.key || boxInteraction?.target === option.key
                      ? styles.selectedBoxActive
                      : ""
                  }`}
                  onPointerDown={(e) => handleBoxPointerDown(e, option.key)}
                  style={{
                    left: `${region.x * 100}%`,
                    top: `${region.y * 100}%`,
                    width: `${region.width * 100}%`,
                    height: `${region.height * 100}%`,
                    border: `2px solid ${option.color}`,
                    background: `${option.color}28`,
                    cursor: "move",
                  }}
                >
                  <span
                    className={`${styles.boxLabel} ${region.y < 0.08 ? styles.boxLabelBelow : ""}`}
                  >
                    {option.label}
                  </span>
                  {(["nw", "ne", "sw", "se"] as ResizeHandle[]).map((handle) => (
                    <button
                      key={handle}
                      type="button"
                      className={`${styles.resizeHandle} ${styles[`handle${handle.charAt(0).toUpperCase()}${handle.charAt(1)}` as keyof typeof styles]}`}
                      onPointerDown={(e) => handleResizePointerDown(e, option.key, handle)}
                      aria-label={`Resize ${option.label}`}
                    />
                  ))}
                </div>
              );
            })}

            {draftBox && (
              <div
                className={styles.draftBox}
                style={{
                  left: `${Math.min(draftBox.startX, draftBox.currentX)}px`,
                  top: `${Math.min(draftBox.startY, draftBox.currentY)}px`,
                  width: `${Math.abs(draftBox.currentX - draftBox.startX)}px`,
                  height: `${Math.abs(draftBox.currentY - draftBox.startY)}px`,
                  border: `2px dashed ${SELECTION_OPTIONS.find((o) => o.key === selectionTarget)?.color ?? "#6C720C"}`,
                  background: `${SELECTION_OPTIONS.find((o) => o.key === selectionTarget)?.color ?? "#6C720C"}22`,
                }}
              >
                <span
                  className={`${styles.boxLabel} ${
                    Math.min(draftBox.startY, draftBox.currentY) < 40 ? styles.boxLabelBelow : ""
                  }`}
                >
                  {SELECTION_OPTIONS.find((o) => o.key === selectionTarget)?.label ?? "Selection"}
                </span>
              </div>
            )}
          </div>

          {fullscreen && zoomScale > 1 && (
            <button
              type="button"
              className={styles.zoomResetButton}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setZoomScale(1);
                setZoomOffset({ x: 0, y: 0 });
              }}
            >
              {Math.round(zoomScale * 100)}% · Reset
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={applySelectedColumns}
        disabled={!hasCompletePage || !selectedFile || isApplyingSelection}
        className={styles.applySelectionButton}
      >
        {isApplyingSelection ? "Applying…" : "Apply Selected Regions"}
      </button>
    </>
  );

  return (
    <main className={styles.container}>
      <section className={styles.card}>
        <p className={styles.stepLabel}>Step 1</p>
        <h1 className={styles.title}>Set Up Your Split</h1>

        {/* ── People first ── */}
        <div className={styles.participantSection} style={{ marginTop: "1.5rem" }}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Who&apos;s splitting?</h2>
            <p className={styles.sectionText}>
              Add everyone before uploading the receipt. You can always add more later.
            </p>
          </div>

          <div className={styles.participantList}>
            {participants.map((participant, index) => (
              <div key={participant.id} className={styles.participantRow}>
                <label className={styles.inputGroup}>
                  <span className={styles.inputLabel}>Person {index + 1}</span>
                  <input
                    type="text"
                    value={participant.name}
                    onChange={(e) => updateParticipantName(participant.id, e.target.value)}
                    placeholder="Enter name"
                    className={styles.nameInput}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeParticipant(participant.id)}
                  className={styles.deleteButton}
                  disabled={participants.length === 1}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>

          <button type="button" onClick={addParticipant} className={styles.addButton}>
            + Add Person
          </button>
        </div>

        <hr className={styles.sectionDivider} />

        {/* ── PDF section ── */}
        <div className={styles.pdfSection}>
          <div className={styles.sectionHeader}>
            <h2 className={styles.sectionTitle}>Upload Receipt</h2>
            <p className={styles.sectionText}>
              Drop a PDF or photo of your receipt below (PDF, HEIC, JPG, or PNG). After the preview loads, use
              guided setup to mark the item and price columns. For multi-page receipts, switch pages above the
              preview and mark each page that has items — tax/tip/total only need marking on whichever page they
              actually appear on.
            </p>
          </div>

          {/* Drop zone */}
          <div
            className={`${styles.dropZone} ${isDragOver ? styles.dropZoneActive : ""}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={handleDropZoneDragOver}
            onDragLeave={handleDropZoneDragLeave}
            onDrop={handleDropZoneDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf,.heic,.heif,image/heic,image/heif,.jpg,.jpeg,image/jpeg,.png,image/png"
              onChange={handleFileInputChange}
              className={styles.hiddenInput}
              disabled={isReadingPdf}
            />
            <span className={styles.dropZoneIcon}>{isReadingPdf ? "⏳" : "📄"}</span>
            <p className={styles.dropZoneText}>
              {isReadingPdf
                ? "Reading receipt…"
                : <>Drop your receipt here, or <span className={styles.dropZoneTextHighlight}>click to browse</span></>}
            </p>
            <p className={styles.dropZoneHint}>PDF, HEIC, JPG, or PNG</p>
          </div>

          {uploadedFileName && (
            <div className={styles.selectedFileRow}>
              <span className={styles.selectedFileLabel}>File:</span>
              <span className={styles.selectedFileValue}>{uploadedFileName}</span>
            </div>
          )}

          {statusMessage && (
            <div className={styles.statusCard}>
              <p className={styles.statusText}>{statusMessage}</p>
              {scanSource && (
                <p className={styles.statusMeta}>
                  Source:{" "}
                  {scanSource === "ocr"
                    ? "OCR fallback"
                    : scanSource === "selected-columns"
                    ? "Selected columns"
                    : "PDF text layer"}
                </p>
              )}
            </div>
          )}

          {/* Preview + guided selector */}
          {previewPages.length > 0 && (
            <div className={styles.previewSection}>
              <div className={styles.sectionHeader} style={{ marginBottom: "0.75rem" }}>
                <h3 className={styles.sectionTitle}>Region Selector</h3>
                <p className={styles.sectionText}>
                  Mark the columns and any summary amounts. Use guided setup for step-by-step help.
                </p>
              </div>

              {isFullscreenDrawing ? (
                <p className={styles.fullscreenActiveHint}>
                  Drawing in fullscreen — tap Done above to come back here.
                </p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setIsFullscreenDrawing(true)}
                    className={styles.fullscreenToggleButton}
                  >
                    ⛶ Draw fullscreen
                  </button>
                  {renderRegionSelectorBody(false)}
                </>
              )}
            </div>
          )}

          {/* Mobile-friendly fullscreen drawing mode — same state and handlers as above,
              just rendered bigger so precise box-drawing on a small phone screen is actually
              usable. Exiting keeps whatever was drawn, since it's the same underlying state. */}
          {isFullscreenDrawing && (
            <div className={styles.fullscreenOverlay}>
              <div className={styles.fullscreenHeader}>
                <span className={styles.fullscreenHeaderTitle}>Mark Regions</span>
                <button
                  type="button"
                  onClick={() => setIsFullscreenDrawing(false)}
                  className={styles.fullscreenExitButton}
                >
                  ✕ Done
                </button>
              </div>
              <div className={styles.fullscreenScroll}>{renderRegionSelectorBody(true)}</div>
            </div>
          )}

          {/* Raw text dump — collapsed by default */}
          {(pdfText || pdfLines.length > 0) && (
            <div className={styles.rawTextSection}>
              <button
                type="button"
                onClick={() => setShowRawText((v) => !v)}
                className={styles.rawTextToggle}
              >
                Show raw text {showRawText ? "▲" : "▾"}
              </button>
              {showRawText && (
                <div className={styles.rawTextBody}>
                  {pdfText && (
                    <div className={styles.scannedTextContainer}>
                      <p className={styles.scannedTextTitle}>Scanned Text</p>
                      <p className={styles.scannedText}>{pdfText}</p>
                    </div>
                  )}
                  {pdfLines.length > 0 && (
                    <div className={styles.linesCard} style={{ marginTop: "0.75rem" }}>
                      <p className={styles.linesTitle}>Extracted Lines</p>
                      <ol className={styles.linesList}>
                        {pdfLines.map((line, i) => (
                          <li key={`${i}-${line}`} className={styles.lineItem}>
                            <span className={styles.lineNumber}>{i + 1}</span>
                            <span>{line}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Detected rows: editable list on the left, receipt always visible on the right */}
          {(itemRows?.length ?? 0) > 0 && (
            <div className={styles.detectedRowsSplit}>
              <div className={styles.detectedRowsPane}>
                <div className={styles.detectedRowsHeader}>
                  <p className={styles.linesTitle}>
                    {itemRows!.length} Detected Bill Row{itemRows!.length !== 1 ? "s" : ""}
                  </p>
                  <button
                    type="button"
                    onClick={() => setIsEditingRows((prev) => !prev)}
                    className={`${styles.editRowsButton} ${isEditingRows ? styles.editRowsButtonActive : ""}`}
                  >
                    {isEditingRows ? "Done" : "Edit"}
                  </button>
                </div>

                <ol className={styles.editableRowsList}>
                  {isEditingRows && (
                    <li className={styles.insertRowGap}>
                      <button
                        type="button"
                        className={styles.insertRowButton}
                        onClick={() => insertDetectedRowAt(0)}
                        aria-label="Insert row at top"
                      >
                        +
                      </button>
                    </li>
                  )}
                  {itemRows?.map((row, index) => (
                    <li key={row.id}>
                      <div
                        ref={(el) => {
                          if (el) rowRefs.current.set(row.id, el);
                          else rowRefs.current.delete(row.id);
                        }}
                        className={
                          isEditingRows
                            ? `${styles.editableRowItem} ${draggedRowId === row.id ? styles.editableRowItemDragging : ""} ${
                                dragOverRowId === row.id ? styles.editableRowItemDragOver : ""
                              }`
                            : styles.lineItem
                        }
                      >
                        {isEditingRows ? (
                          <>
                            {/* Only the handle itself starts a drag — starting from an <input> would just select text instead of moving the row. */}
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
                              onChange={(e) => updateDetectedRow(row.id, "name", e.target.value)}
                              placeholder="Item name"
                              className={`${styles.rowFieldInput} ${styles.rowNameInput}`}
                            />
                            <input
                              type="number"
                              min="1"
                              step="1"
                              value={row.quantity}
                              onChange={(e) => updateDetectedRow(row.id, "quantity", e.target.value)}
                              className={`${styles.rowFieldInput} ${styles.rowNumberInput}`}
                              title="Quantity"
                            />
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={row.unitCost}
                              onChange={(e) => updateDetectedRow(row.id, "unitCost", e.target.value)}
                              className={`${styles.rowFieldInput} ${styles.rowNumberInput}`}
                              title="Cost per item"
                            />
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={row.totalCost}
                              onChange={(e) => updateDetectedRow(row.id, "totalCost", e.target.value)}
                              className={`${styles.rowFieldInput} ${styles.rowNumberInput}`}
                              title="Total cost"
                            />
                            <button
                              type="button"
                              onClick={() => removeDetectedRow(row.id)}
                              className={styles.rowRemoveButton}
                              aria-label={`Remove ${row.name || "row"}`}
                            >
                              ×
                            </button>
                          </>
                        ) : (
                          <>
                            <span className={styles.lineNumber}>{row.quantity}</span>
                            <span>
                              <strong>{row.name}</strong> · ${row.unitCost.toFixed(2)} each · ${row.totalCost.toFixed(2)} total
                            </span>
                          </>
                        )}
                      </div>
                      {isEditingRows && (
                        <div className={styles.insertRowGap}>
                          <button
                            type="button"
                            className={styles.insertRowButton}
                            onClick={() => insertDetectedRowAt(index + 1)}
                            aria-label="Insert row here"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>

                {isEditingRows && (
                  <button type="button" onClick={addDetectedRow} className={styles.addRowButton}>
                    + Add row
                  </button>
                )}
              </div>

              <div className={`${styles.detectedRowsPane} ${styles.detectedRowsStickyPane}`}>
                <div className={styles.detectedRowsHeader}>
                  <p className={styles.linesTitle}>Receipt</p>
                  <button type="button" onClick={clearScratchpad} className={styles.scratchpadClearButton}>
                    Clear marks
                  </button>
                </div>

                {completeReceiptPages.length > 1 && (
                  <div className={styles.pageMiniTabs} style={{ marginTop: "0.6rem" }}>
                    {completeReceiptPages.map((pageIndex) => (
                      <button
                        key={pageIndex}
                        type="button"
                        onClick={() => setReceiptPanePage(pageIndex)}
                        className={`${styles.pageMiniTab} ${
                          effectiveReceiptPage === pageIndex ? styles.pageMiniTabActive : ""
                        }`}
                      >
                        Page {pageIndex + 1}
                      </button>
                    ))}
                  </div>
                )}

                {receiptComposite && (
                  <div className={styles.scratchpadWrapper} style={{ marginTop: "0.6rem" }}>
                    <img
                      src={receiptComposite}
                      alt="Selected item and cost columns"
                      className={styles.scratchpadImage}
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
                )}
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className={styles.nextButton}
          onClick={handleNext}
          disabled={!canContinue}
        >
          {canContinue
            ? `Continue to Split — ${(itemRows?.length ?? 0)} items, ${participantNames.length} people →`
            : participantNames.length === 0
            ? "Add at least one person to continue"
            : "Upload and apply receipt regions to continue"}
        </button>
      </section>
    </main>
  );
}

// Shared between the bill-split tool (app/bill-split/page.tsx) and the expense receipt-scan
// feature (app/(account)/expenses/[id]/scan) — both upload a receipt image/PDF to the same
// backend endpoint and let the user draw boxes over an item column and a price column. This
// file holds only the request/response shapes and drawing-geometry types; each feature keeps
// its own UI state (bill-split assigns rows to people, the scan feature assigns categories).

export type PreviewPage = {
  imageBase64: string;
  width: number;
  height: number;
};

export type PdfReadResponse = {
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

// A single row from PdfReadResponse.itemRows — pulled out as its own name since both features
// pass this shape around independently of the full response.
export type DetectedRow = NonNullable<PdfReadResponse["itemRows"]>[number];

export type NormalizedRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SelectionTarget =
  | "item"
  | "price"
  | "tax"
  | "tip"
  | "fees"
  | "misc"
  | "total";

export type RegionPayloadEntry = NormalizedRegion & {
  target: SelectionTarget;
  page: number;
};

// Regions are scoped per PDF page, since a receipt's item list can span multiple pages
// and its tax/tip/total can live on whichever page actually shows them.
export type PageRegions = Record<SelectionTarget, NormalizedRegion | null>;
export type SelectedRegionsByPage = Record<number, PageRegions>;

export type DraftBox = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

export type BoxInteraction = {
  target: SelectionTarget;
  mode: "move" | "resize";
  handle?: ResizeHandle;
  startX: number;
  startY: number;
  originalRegion: NormalizedRegion;
};

export const SELECTION_OPTIONS: {
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

export const EMPTY_PAGE_REGIONS: PageRegions = {
  item: null,
  price: null,
  tax: null,
  tip: null,
  fees: null,
  misc: null,
  total: null,
};

export function pageHasBothColumns(pageRegions: PageRegions | undefined) {
  return Boolean(pageRegions?.item && pageRegions?.price);
}

export function buildRegionsPayload(selectedRegions: SelectedRegionsByPage): RegionPayloadEntry[] {
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

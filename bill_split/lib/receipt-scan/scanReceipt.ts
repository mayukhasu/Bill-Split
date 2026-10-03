import type { PdfReadResponse, RegionPayloadEntry } from "./types";

// Next.js inlines NEXT_PUBLIC_* vars at build time, so this must be set in Vercel's
// project settings (not just locally) for production builds to reach the real backend.
export const BACKEND_URL = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://127.0.0.1:5001").replace(/\/+$/, "");

export const SUPPORTED_RECEIPT_EXTENSIONS = [".pdf", ".heic", ".heif", ".jpg", ".jpeg", ".png"];

export function isSupportedReceiptFile(filename: string) {
  const lower = filename.toLowerCase();
  return SUPPORTED_RECEIPT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// Calls the shared /read-pdf backend (same endpoint the bill-split tool uses). Pass no
// `regions` for the first call (just gets a preview image back); pass the boxes the user
// drew once they're ready to extract real rows.
export async function scanReceipt(
  file: File,
  regions?: RegionPayloadEntry[]
): Promise<PdfReadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  if (regions && regions.length > 0) {
    formData.append("regions", JSON.stringify(regions));
  }

  const response = await fetch(`${BACKEND_URL}/read-pdf`, {
    method: "POST",
    body: formData,
  });
  const data: PdfReadResponse = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not read the receipt.");
  return data;
}

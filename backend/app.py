import base64
from io import BytesIO
import json
import os
import re

import numpy as np
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps
import pillow_heif
import pypdfium2
from rapidocr_onnxruntime import RapidOCR
import uvicorn

# Registers HEIC/HEIF (the format iPhones save photos as) as a format Pillow's Image.open
# can decode, the same way it already handles JPEG/PNG — nothing downstream needs to know
# the difference between formats after this.
pillow_heif.register_heif_opener()

app = FastAPI(title="MoneySplit Backend")

IMAGE_EXTENSIONS = (".heic", ".heif", ".jpg", ".jpeg", ".png")

# Loaded once at process start — RapidOCR's models ship with the package (no network
# fetch needed), and re-loading them per request would add real latency to every scan.
# The detector defaults missed real, legible lines in a run of near-identical consecutive
# items (e.g. four repeated "SOMETHING SPRITZY GRAPEF" rows on a real receipt) — loosening
# these recovers most of them, verified with no regressions on a second real receipt.
_ocr_engine = RapidOCR(det_box_thresh=0.4, det_unclip_ratio=1.8, det_thresh=0.25)

# FRONTEND_ORIGIN lets the deployed Vercel URL in without hardcoding it into source —
# set it on the host (e.g. Render) once the frontend has a real domain. Local dev origins
# stay allowed either way so `npm run dev` keeps working against a local backend.
_local_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
]
_extra_origin = os.environ.get("FRONTEND_ORIGIN")
allow_origins = _local_origins + ([_extra_origin] if _extra_origin else [])

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


PRICE_TOKEN_PATTERN = re.compile(r"\d{1,4}\.\d{2}")


def extract_price_from_text(text):
    # RapidOCR returns whatever it reads on a line, not a digit-only token, so pull the
    # price out of it (and take the last match — a stray leading character or currency
    # symbol misread as a digit is more likely than a garbled cents value at the end).
    matches = PRICE_TOKEN_PATTERN.findall(text.replace(",", ""))
    if not matches:
        return None
    return float(matches[-1])


def normalize_item_name(line):
    collapsed_line = re.sub(r"\s+", " ", line).strip(" -:_")
    return re.sub(r"[^A-Za-z0-9&'/().,%+\- ]", "", collapsed_line).strip()


def is_summary_line(lower_line):
    summary_patterns = (
        r"\btax\b",
        r"\btip\b",
        r"\bgratuity\b",
        r"\btotal\b",
        r"balance due",
        r"total purchase",
        r"amount due",
    )
    return any(re.search(pattern, lower_line) for pattern in summary_patterns)


def run_ocr(image):
    # RapidOCR's own detector handles skew/orientation and uneven lighting far better than
    # the manual threshold+sharpen pass this replaced — feed it the untouched RGB image.
    result, _ = _ocr_engine(np.array(image.convert("RGB")))
    return result or []


def ocr_box_center(box):
    xs = [point[0] for point in box]
    ys = [point[1] for point in box]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def score_item_entry(text, confidence):
    normalized_text = normalize_item_name(text)
    lower_text = normalized_text.lower()
    alpha_runs = re.findall(r"[A-Za-z]{2,}", normalized_text)

    if len(normalized_text) < 2:
        return -100
    if is_summary_line(lower_text):
        return -50
    if not alpha_runs:
        return -20

    return len(alpha_runs) * 10 + len(normalized_text) * 0.2 + max(confidence, 0) * 0.1


def ocr_results_in_region(ocr_results, region, image_width, image_height):
    # Filtering full-page OCR results by position, rather than cropping the image down to
    # just this region and re-running OCR on the crop, turned out to matter a lot: a tall,
    # narrow column of nothing but stacked prices confuses RapidOCR's line detector into
    # merging the whole column into one unreadable blob. The same text, read in the full
    # page's natural context, comes out perfectly — cropping was the bug, not the model.
    left = region["x"] * image_width
    top = region["y"] * image_height
    right = left + region["width"] * image_width
    bottom = top + region["height"] * image_height

    matches = []
    for box, text, score in ocr_results:
        center_x, center_y = ocr_box_center(box)
        if left <= center_x <= right and top <= center_y <= bottom:
            matches.append((box, text, score))
    return matches


def extract_price_entries(ocr_results, region, image_width, image_height):
    price_entries = []
    for box, text, score in ocr_results_in_region(ocr_results, region, image_width, image_height):
        price_value = extract_price_from_text(text)
        if price_value is None:
            continue

        _, top = ocr_box_center(box)
        price_entries.append(
            {
                "price": round(price_value, 2),
                "confidence": score * 100,
                "top": int(top),
            }
        )

    price_entries.sort(key=lambda entry: entry["top"])
    return price_entries


def extract_item_entries(ocr_results, region, image_width, image_height):
    entries = []
    for box, text, score in ocr_results_in_region(ocr_results, region, image_width, image_height):
        normalized_text = normalize_item_name(text)
        entry_score = score_item_entry(normalized_text, score * 100)
        if entry_score <= 0:
            continue

        _, top = ocr_box_center(box)
        entries.append(
            {
                "top": int(top),
                "text": normalized_text,
                "score": entry_score,
            }
        )

    entries.sort(key=lambda entry: entry["top"])
    return entries


def extract_amount(ocr_results, region, image_width, image_height):
    price_entries = extract_price_entries(ocr_results, region, image_width, image_height)
    if not price_entries:
        return None

    # These summary boxes should usually contain a single amount. If OCR sees more
    # than one price, prefer the last one because totals often sit at the bottom
    # of the selected label block.
    return round(price_entries[-1]["price"], 2)


def convert_image_to_pdf_bytes(image_bytes):
    # Wrapping a photo in a single-page PDF, rather than teaching the rest of the pipeline
    # a second code path, means every page-rendering/OCR function below keeps working
    # unchanged — and Pillow's default PDF export happens to encode at 1pt=1px, which is
    # exactly the "photo wrapped in a PDF" shape compute_render_scale was already built to
    # handle safely (see the memory-cap comment on that function).
    image = Image.open(BytesIO(image_bytes))
    # Phone cameras (Android and iPhone alike) commonly store the photo in sensor
    # orientation plus an EXIF rotation tag rather than pre-rotating the pixels — without
    # this, a portrait photo can come back sideways.
    image = ImageOps.exif_transpose(image)
    if image.mode != "RGB":
        image = image.convert("RGB")
    pdf_buffer = BytesIO()
    image.save(pdf_buffer, format="PDF")
    return pdf_buffer.getvalue()


def compute_render_scale(page, target_long_side, min_scale=1.0, max_scale=4.0):
    # A fixed multiplier made sense for low-DPI digital PDFs, but a PDF that just wraps a
    # full-resolution phone photo doesn't need — and can't afford — being blown up 4x on
    # top of that (a real receipt photo hit 12096x16128px this way, ~585MB as a raw array,
    # large enough that Pillow's own decompression-bomb guard rejects it as looking like an
    # attack). Scale relative to the page's actual size instead of assuming it's always small.
    width_pt, height_pt = page.get_size()
    long_side_pt = max(width_pt, height_pt)
    if long_side_pt <= 0:
        return max_scale
    return max(min_scale, min(target_long_side / long_side_pt, max_scale))


def render_page_image(document, page_index, target_long_side, min_scale=1.0, max_scale=4.0):
    page = document.get_page(page_index)
    try:
        scale = compute_render_scale(page, target_long_side, min_scale, max_scale)
        return page.render(scale=scale).to_pil()
    finally:
        page.close()


def render_pdf_preview_pages(document):
    preview_pages = []
    for page_index in range(len(document)):
        # No min_scale floor here — unlike the OCR render, the preview is free to shrink
        # below native resolution for a huge source photo; it's just for the user to look at.
        image = render_page_image(document, page_index, target_long_side=1600, min_scale=0.1)
        image_buffer = BytesIO()
        image.save(image_buffer, format="PNG")
        preview_pages.append(
            {
                "imageBase64": base64.b64encode(image_buffer.getvalue()).decode("utf-8"),
                "width": image.width,
                "height": image.height,
            }
        )
    return preview_pages


def extract_quantity_and_name(item_text):
    quantity_match = re.match(r"^\s*(\d+)\s+(.+)$", item_text)
    if quantity_match:
        quantity = max(1, int(quantity_match.group(1)))
        return quantity, normalize_item_name(quantity_match.group(2))

    return 1, normalize_item_name(item_text)


def build_item_rows_from_column_entries(item_entries, price_entries):
    if not price_entries:
        return []

    sorted_item_entries = sorted(item_entries, key=lambda entry: entry["top"])
    sorted_price_entries = sorted(price_entries, key=lambda entry: entry["top"])

    # When OCR found exactly as many item lines as prices, trust reading order over pixel
    # distance. A long or two-line-wrapped item name can legitimately sit much farther from
    # its price than a normal row gap (seen on a real receipt: 89px vs. a ~69px threshold
    # computed from the other rows), which broke an otherwise-correct 1:1 correspondence.
    if len(sorted_item_entries) == len(sorted_price_entries):
        item_rows = []
        for index, (item_entry, price_entry) in enumerate(zip(sorted_item_entries, sorted_price_entries)):
            quantity, item_name = extract_quantity_and_name(item_entry["text"])
            if len(item_name) < 2:
                item_name = f"Unlabeled item {index + 1}"

            total_cost = round(price_entry["price"], 2)
            unit_cost = round(total_cost / quantity, 2) if quantity > 0 else total_cost
            item_rows.append(
                {
                    "id": f"column-row-{index}",
                    "name": item_name,
                    "quantity": quantity,
                    "unitCost": unit_cost,
                    "totalCost": total_cost,
                }
            )
        return item_rows

    # Counts differ — fall back to matching each price to whichever nearby item line hasn't
    # already been claimed, since we can no longer assume a clean 1:1 correspondence.
    price_tops = [price_entry["top"] for price_entry in sorted_price_entries]
    price_gaps = [
        price_tops[index + 1] - price_tops[index]
        for index in range(len(price_tops) - 1)
        if price_tops[index + 1] > price_tops[index]
    ]
    median_gap = (
        sorted(price_gaps)[len(price_gaps) // 2]
        if price_gaps
        else 50
    )
    match_threshold = max(28, int(median_gap * 0.8))

    unmatched_item_entries = sorted_item_entries.copy()
    item_rows = []

    # Pair each detected price row with the closest item-name row in the user-selected item column.
    for index, price_entry in enumerate(sorted_price_entries):
        best_match_index = None
        best_match_distance = None

        for item_index, item_entry in enumerate(unmatched_item_entries):
            distance = abs(item_entry["top"] - price_entry["top"])
            if distance > match_threshold:
                continue

            if best_match_distance is None or distance < best_match_distance:
                best_match_index = item_index
                best_match_distance = distance

        if best_match_index is not None:
            matched_item_entry = unmatched_item_entries.pop(best_match_index)
            quantity, item_name = extract_quantity_and_name(matched_item_entry["text"])
            if len(item_name) < 2:
                item_name = f"Unlabeled item {index + 1}"
        else:
            quantity = 1
            item_name = f"Unlabeled item {index + 1}"

        total_cost = round(price_entry["price"], 2)
        unit_cost = round(total_cost / quantity, 2) if quantity > 0 else total_cost
        item_rows.append(
            {
                "id": f"column-row-{index}",
                "name": item_name,
                "quantity": quantity,
                "unitCost": unit_cost,
                "totalCost": total_cost,
            }
        )

    return item_rows


def build_selected_region_text(item_rows):
    lines = [
        f"{item_row['name']} {item_row['totalCost']:.2f}"
        for item_row in item_rows
    ]
    return "\n".join(lines), lines


def append_summary_lines(full_text, lines, summary):
    summary_lines = []
    if summary.get("tax") is not None:
        summary_lines.append(f"Tax {summary['tax']:.2f}")
    if summary.get("tip") is not None:
        summary_lines.append(f"Tip {summary['tip']:.2f}")
    if summary.get("misc") is not None:
        summary_lines.append(f"Misc {summary['misc']:.2f}")
    if summary.get("total") is not None:
        summary_lines.append(f"Total {summary['total']:.2f}")

    if not summary_lines:
        return full_text, lines

    combined_lines = [*lines, *summary_lines]
    return "\n".join(combined_lines), combined_lines


@app.get("/")
def health_check():
    return {
        "status": "ok",
        "mode": "region-select-ocr",
        "message": "Draw item/price/summary boxes per page; the backend OCRs each selected region.",
    }


@app.post("/read-pdf")
async def read_pdf(
    file: UploadFile = File(...),
    regions: str | None = Form(default=None),
):
    if not file.filename:
        return JSONResponse(
            status_code=400,
            content={"error": "Please upload a PDF or photo of a receipt."},
        )

    filename_lower = file.filename.lower()
    is_pdf = filename_lower.endswith(".pdf")
    is_image = filename_lower.endswith(IMAGE_EXTENSIONS)
    if not is_pdf and not is_image:
        return JSONResponse(
            status_code=400,
            content={"error": "Only PDF, HEIC, JPG, and PNG files are supported."},
        )

    uploaded_bytes = await file.read()
    if not uploaded_bytes:
        return JSONResponse(
            status_code=400,
            content={"error": "The uploaded file is empty."},
        )

    if is_pdf:
        pdf_bytes = uploaded_bytes
    else:
        try:
            pdf_bytes = convert_image_to_pdf_bytes(uploaded_bytes)
        except Exception:
            return JSONResponse(
                status_code=400,
                content={"error": "Could not read that image. Try a different photo or a PDF."},
            )

    document = pypdfium2.PdfDocument(pdf_bytes)
    page_count = len(document)
    preview = {
        "pageCount": page_count,
        "pages": render_pdf_preview_pages(document),
    }

    parsed_regions = []
    if regions:
        try:
            parsed_regions = json.loads(regions)
        except json.JSONDecodeError:
            return JSONResponse(
                status_code=400,
                content={"error": "The selected regions could not be parsed."},
            )

    if not parsed_regions:
        return {
            "text": "",
            "lines": [],
            "itemRows": [],
            "summary": {
                "total": None,
                "tax": None,
                "tip": None,
            },
            "preview": preview,
        }

    # Group the regions the frontend drew (each tagged with a target + which page it's on).
    regions_by_target = {}
    for region in parsed_regions:
        page_index = region.get("page", 0)
        if not isinstance(page_index, int) or page_index < 0 or page_index >= page_count:
            continue
        regions_by_target.setdefault(region["target"], []).append(region)

    for target_regions in regions_by_target.values():
        target_regions.sort(key=lambda region: region["page"])

    item_regions_by_page = {region["page"]: region for region in regions_by_target.get("item", [])}
    price_regions_by_page = {region["page"]: region for region in regions_by_target.get("price", [])}
    pages_with_columns = sorted(set(item_regions_by_page) & set(price_regions_by_page))

    if not pages_with_columns:
        return JSONResponse(
            status_code=400,
            content={
                "error": "Select both the item column and the cost column on at least one page before reading the receipt.",
            },
        )

    # Run OCR on each page at most once — every region on that page (item/price/tax/tip/...)
    # is answered by filtering this same result set, not by cropping and re-OCRing per region.
    page_ocr_cache = {}

    def get_page_ocr(page_index):
        if page_index not in page_ocr_cache:
            # min_scale=1.0 here would floor the render at native resolution — fine for a
            # normal low-DPI PDF page, but a PDF that wraps a full-res phone photo (e.g.
            # 3024x4032pt, 1pt=1px) would then ignore target_long_side entirely and OCR the
            # full-size image. That's a real memory risk (an even larger source photo than the
            # two on file would OCR at its full native size with no cap at all), so let it
            # shrink freely rather than floor at native res. Note this alone isn't enough to
            # keep a request under Render's free-tier 512MB — RapidOCR's detector itself peaks
            # around 900MB-1GB on these images regardless of this cap (verified below).
            # 2800 (not 2400) is deliberate: verified against both real receipts on file —
            # 2400 and 3200 both make RapidOCR's detector drop one line on the grocery
            # receipt, shifting every price after it onto the wrong item; 2800 matches the
            # full-resolution result exactly on both while still reducing pixel count ~50%.
            page_image = render_page_image(document, page_index, target_long_side=2800, min_scale=0.1)
            page_ocr_cache[page_index] = (run_ocr(page_image), page_image.width, page_image.height)
        return page_ocr_cache[page_index]

    # Item lists that continue onto later pages get scanned page by page, in page order,
    # and stitched into one row list — instead of assuming everything lives on page 1.
    item_rows = []
    for page_index in pages_with_columns:
        ocr_results, image_width, image_height = get_page_ocr(page_index)
        item_entries = extract_item_entries(ocr_results, item_regions_by_page[page_index], image_width, image_height)
        price_entries = extract_price_entries(ocr_results, price_regions_by_page[page_index], image_width, image_height)
        item_rows.extend(build_item_rows_from_column_entries(item_entries, price_entries))

    for row_index, item_row in enumerate(item_rows):
        item_row["id"] = f"column-row-{row_index}"

    full_text, lines = build_selected_region_text(item_rows)

    def first_amount(target):
        for region in regions_by_target.get(target, []):
            ocr_results, image_width, image_height = get_page_ocr(region["page"])
            amount = extract_amount(ocr_results, region, image_width, image_height)
            if amount is not None:
                return amount
        return None

    summary = {
        "tax": first_amount("tax"),
        "tip": first_amount("tip"),
    }
    fees_amount = first_amount("fees")
    misc_amount = first_amount("misc")
    summary["misc"] = round(
        (fees_amount or 0) + (misc_amount or 0),
        2,
    ) if fees_amount is not None or misc_amount is not None else None
    summary["total"] = first_amount("total")
    full_text, lines = append_summary_lines(full_text, lines, summary)

    return {
        "text": full_text,
        "lines": lines,
        "source": "selected-columns",
        "itemRows": item_rows,
        "summary": summary,
        "preview": preview,
    }


if __name__ == "__main__":
    # Support the same "python3 app.py" workflow the project used before switching to FastAPI.
    uvicorn.run("app:app", host="127.0.0.1", port=5001, reload=True)

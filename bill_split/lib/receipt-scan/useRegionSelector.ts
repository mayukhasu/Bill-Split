import { useRef, useState } from "react";
import {
  EMPTY_PAGE_REGIONS,
  pageHasBothColumns,
  buildRegionsPayload,
  type PreviewPage,
  type NormalizedRegion,
  type DraftBox,
  type ResizeHandle,
  type BoxInteraction,
  type SelectionTarget,
  type SelectedRegionsByPage,
} from "./types";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// Drawing/resizing/pinch-zoom state for "mark boxes over a receipt preview image," reused
// from the same logic bill-split/page.tsx already has inline. This is a standalone copy
// adapted for a second caller (the expense receipt-scan feature) rather than a shared import
// — bill-split's version stays as-is for now, since migrating 1484 lines of working,
// pointer/pinch-zoom code onto a brand-new hook before that hook has proven itself here would
// risk the one feature that already works end-to-end. Once both are live, folding bill-split
// onto this hook is a safe follow-up.
export function useRegionSelector() {
  const previewContainerRef = useRef<HTMLDivElement | null>(null);

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

  const [previewPages, setPreviewPages] = useState<PreviewPage[]>([]);
  const [activePage, setActivePage] = useState(0);
  const [selectedRegions, setSelectedRegions] = useState<SelectedRegionsByPage>({});
  const [selectionTarget, setSelectionTarget] = useState<SelectionTarget>("item");
  const [draftBox, setDraftBox] = useState<DraftBox | null>(null);
  const [boxInteraction, setBoxInteraction] = useState<BoxInteraction | null>(null);
  const [isFullscreenDrawing, setIsFullscreenDrawing] = useState(false);
  const [zoomScale, setZoomScale] = useState(1);
  const [zoomOffset, setZoomOffset] = useState({ x: 0, y: 0 });

  const activePageRegions = selectedRegions[activePage] ?? EMPTY_PAGE_REGIONS;
  const activePreviewPage = previewPages[activePage] ?? null;
  const hasCompletePage = Object.values(selectedRegions).some(pageHasBothColumns);

  // Call this whenever a new file is picked, so a second upload doesn't inherit boxes drawn
  // on the previous receipt.
  const resetForNewFile = () => {
    setPreviewPages([]);
    setActivePage(0);
    setSelectedRegions({});
    setSelectionTarget("item");
    setDraftBox(null);
    setBoxInteraction(null);
  };

  const switchToPage = (pageIndex: number) => {
    setActivePage(pageIndex);
    setDraftBox(null);
    setBoxInteraction(null);
  };

  // Converts a screen point to the canvas's own unscaled coordinate space — i.e. undoes the
  // pinch-zoom transform (translate then scale) so drawing/moving/resizing math never needs
  // to know whether the user is currently zoomed in. Outside fullscreen, zoomScale is always
  // 1 and zoomOffset always {0,0}, so this is equivalent to plain `clientX - rect.left`.
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
    setDraftBox((prev) => (prev ? { ...prev, currentX, currentY } : null));
  };

  // Returns the freshly-committed region (or null if nothing was dropped — too small a drag,
  // or a pinch/box-adjustment was in progress instead) so the caller can show a status
  // message; mirrors bill-split's inline version but leaves messaging to the component.
  const handlePreviewPointerUp = (
    event: React.PointerEvent<HTMLDivElement>
  ): { target: SelectionTarget; page: number } | null => {
    if (releaseFullscreenPointer(event.pointerId)) return null;

    if (boxInteraction) {
      setBoxInteraction(null);
      return null;
    }
    if (!draftBox || !previewContainerRef.current) {
      setDraftBox(null);
      return null;
    }

    const rect = previewContainerRef.current.getBoundingClientRect();
    const left = Math.min(draftBox.startX, draftBox.currentX);
    const top = Math.min(draftBox.startY, draftBox.currentY);
    const width = Math.abs(draftBox.currentX - draftBox.startX);
    const height = Math.abs(draftBox.currentY - draftBox.startY);

    if (width < 10 || height < 10) {
      setDraftBox(null);
      return null;
    }

    const region: NormalizedRegion = {
      x: left / rect.width,
      y: top / rect.height,
      width: width / rect.width,
      height: height / rect.height,
    };
    setSelectedRegions((prev) => ({
      ...prev,
      [activePage]: { ...(prev[activePage] ?? EMPTY_PAGE_REGIONS), [selectionTarget]: region },
    }));
    setDraftBox(null);
    return { target: selectionTarget, page: activePage };
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

  // For onPointerCancel/onPointerLeave: clears any in-progress drag (drawing a new box,
  // moving/resizing an existing one) left dangling when a pointer leaves the canvas or the
  // OS cancels it mid-gesture — e.g. a finger sliding off the image while drawing. Safe to
  // call unconditionally; it's a no-op if nothing was in progress.
  const cancelInteraction = () => {
    setDraftBox(null);
    setBoxInteraction(null);
  };

  return {
    previewContainerRef,
    previewPages,
    setPreviewPages,
    activePage,
    switchToPage,
    resetForNewFile,
    selectedRegions,
    selectionTarget,
    setSelectionTarget,
    draftBox,
    boxInteraction,
    isFullscreenDrawing,
    setIsFullscreenDrawing,
    zoomScale,
    zoomOffset,
    activePageRegions,
    activePreviewPage,
    hasCompletePage,
    regionsPayload: buildRegionsPayload(selectedRegions),
    handlePreviewPointerDown,
    handlePreviewPointerMove,
    handlePreviewPointerUp,
    handleBoxPointerDown,
    handleResizePointerDown,
    releaseFullscreenPointer,
    cancelInteraction,
  };
}

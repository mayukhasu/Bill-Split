"use client";

import { useEffect } from "react";

// Native <details>/<summary> dropdowns (the account burger menu, each expense row's "⋮" menu)
// only close by re-clicking their own toggle by default — this adds the click-outside-to-close
// behavior a dropdown is expected to have, via one document-level listener, without turning any
// of those menus into a Client Component themselves.
export default function CloseDetailsOnOutsideClick() {
  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      document.querySelectorAll("details[open]").forEach((details) => {
        if (!details.contains(target)) {
          details.removeAttribute("open");
        }
      });
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  return null;
}

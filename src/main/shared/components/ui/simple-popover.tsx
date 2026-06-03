// ============================================================
// SimplePopover — lightweight dropdown (no Radix, no floating-ui)
// Bypasses Radix internals (RovingFocusGroup, Portal, etc.)
// for performance-sensitive dropdown menus.
// ============================================================

import React, { useState, useRef, useEffect, useCallback } from "react";

interface SimplePopoverProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}

export default function SimplePopover({
  trigger,
  children,
  align = "start",
  className = "",
}: SimplePopoverProps) {
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"bottom" | "top">("bottom");
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node) &&
        panelRef.current &&
        !panelRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Choose side based on available space
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    setSide(spaceBelow >= 320 || spaceBelow >= spaceAbove ? "bottom" : "top");
  }, [open]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="relative inline-flex">
      <div ref={triggerRef} onClick={toggle}>
        {trigger}
      </div>
      {open && (
        <div
          ref={panelRef}
          className={`absolute z-50 ${
            side === "bottom" ? "top-full mt-1" : "bottom-full mb-1"
          } ${align === "end" ? "right-0" : "left-0"} ${className}`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

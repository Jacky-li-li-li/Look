// ============================================================
// SimplePopover — Portal-based popover with intelligent placement
//
// Renders the panel via createPortal at document.body to escape
// ancestor `overflow: hidden` clipping, then computes a fixed
// position from the trigger's getBoundingClientRect() and
// auto-flips above/below based on available viewport space.
//
// Why portal: the chat input row sits inside nested
// overflow-hidden containers (<main class="overflow-hidden"> and
// <div class="app-shell ... overflow-hidden">). An
// `absolute`-positioned popover inside this chain gets clipped at
// the nearest clipping ancestor — z-index can't escape
// `overflow: hidden`. The Portal bypasses the chain entirely.
// ============================================================

import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

interface SimplePopoverProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
  /** Estimated panel height in px — used to decide flip direction
   *  before the panel mounts. Defaults to 280. */
  preferredHeight?: number;
}

interface PopoverPosition {
  top: number;
  left: number;
  placement: "up" | "down";
  /** Max height the panel may take. Content beyond this scrolls. */
  maxHeight: number;
}

const VIEWPORT_MARGIN = 8;
const GAP = 6;
const MIN_PANEL_H = 80;

export default function SimplePopover({
  trigger,
  children,
  align = "start",
  className = "",
  preferredHeight = 280,
}: SimplePopoverProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const computePosition = useCallback((): PopoverPosition | null => {
    const triggerEl = triggerRef.current;
    if (!triggerEl) return null;
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Use the panel's real measured size if it's mounted, else fall
    // back to the consumer's preferred estimate so the first frame is
    // close enough to pick a sensible placement.
    const panelH = panelRef.current?.offsetHeight ?? preferredHeight;
    const panelW = panelRef.current?.offsetWidth ?? 288;

    const spaceAbove = rect.top - VIEWPORT_MARGIN;
    const spaceBelow = vh - rect.bottom - VIEWPORT_MARGIN;
    // Prefer "up" (trigger lives near the bottom of the screen) but
    // flip "down" if there's clearly more room below.
    const placement: "up" | "down" =
      spaceAbove >= panelH + GAP || spaceAbove >= spaceBelow ? "up" : "down";

    // Cap the panel's height so it never overflows the viewport in
    // its placement direction. Inner content scrolls.
    const availableH = (placement === "up" ? spaceAbove : spaceBelow) - GAP;
    const maxHeight = Math.max(MIN_PANEL_H, Math.min(panelH, availableH));

    const top =
      placement === "up"
        ? Math.max(VIEWPORT_MARGIN, rect.top - maxHeight - GAP)
        : Math.min(vh - maxHeight - VIEWPORT_MARGIN, rect.bottom + GAP);

    let left: number;
    if (align === "end") {
      // right edge of panel aligns with right edge of trigger
      left = rect.right - panelW;
    } else {
      // left edge of panel aligns with left edge of trigger
      left = rect.left;
    }
    // Clamp horizontally so the panel never leaves the viewport.
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - panelW - VIEWPORT_MARGIN));

    return { top, left, placement, maxHeight };
  }, [align, preferredHeight]);

  // Re-compute on open, resize, and any scroll (capture: true to
  // catch scrolling inside the message list, the panel itself, etc.).
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const update = () => setPosition(computePosition());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, computePosition]);

  // Close on click outside — works for portaled content because we
  // still hold the panel ref and check it directly.
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Defer attaching the listener so the click that opened the
    // popover doesn't immediately close it.
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

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="inline-flex">
      <div
        ref={triggerRef}
        className="group/selector"
        onClick={toggle}
        data-state={open ? "open" : "closed"}
      >
        {trigger}
      </div>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            className={`fixed z-[9999] ${className} ${
              position
                ? position.placement === "up"
                  ? "animate-popover-in-up"
                  : "animate-popover-in-down"
                : "invisible"
            }`}
            style={
              position
                ? {
                    top: position.top,
                    left: position.left,
                    maxHeight: `${position.maxHeight}px`,
                  }
                : { top: 0, left: 0 }
            }
            onClick={() => setOpen(false)}
          >
            {children}
          </div>,
          document.body
        )}
    </div>
  );
}

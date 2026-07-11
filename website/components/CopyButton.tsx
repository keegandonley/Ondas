"use client";

import { useRef, useState } from "react";

const RESET_DELAY_MS = 1600;

export function CopyButton({ command }: { command: string }) {
  const [label, setLabel] = useState("Copy");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function flash(next: string) {
    setLabel(next);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setLabel("Copy"), RESET_DELAY_MS);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(command);
      flash("Copied");
    } catch {
      flash("Failed");
    }
  }

  return (
    <button
      className="copy-btn"
      type="button"
      onClick={handleCopy}
      aria-label={`Copy install command${label === "Copy" ? "" : ` — ${label}`}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
      <span className="copy-label" aria-live="polite">
        {label}
      </span>
    </button>
  );
}

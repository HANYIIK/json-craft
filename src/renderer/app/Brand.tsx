export function Brand() {
  return (
    <div className="brand">
      <svg
        className="brand-mark"
        width="32"
        height="32"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x="1"
          y="1"
          width="30"
          height="30"
          rx="8"
          fill="var(--accent-soft)"
          stroke="var(--border-strong)"
          strokeWidth="1"
        />
        <g
          stroke="var(--accent)"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 8h-1a2 2 0 0 0-2 2v3c0 1.5-.7 2.5-2 3 1.3.5 2 1.5 2 3v3a2 2 0 0 0 2 2h1" />
          <path d="M20 8h1a2 2 0 0 1 2 2v3c0 1.5.7 2.5 2 3-1.3.5-2 1.5-2 3v3a2 2 0 0 1-2 2h-1" />
        </g>
        <circle cx="16" cy="16" r="1.3" fill="var(--warning)" />
      </svg>
      <span className="brand-wordmark">
        <span className="brand-json">JSON</span>{" "}
        <span className="brand-craft">Craft</span>
      </span>
    </div>
  );
}

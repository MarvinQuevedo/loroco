import { useState } from "react";

// Mono value + copy button. `display` lets callers show a shortened form
// while still copying the full value (never copy the truncated string).
export function CopyText({ text, display }: { text: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copytext">
      <code>{display ?? text}</code>
      <button
        type="button"
        title="Copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          } catch {
            /* clipboard blocked */
          }
        }}
      >
        {copied ? "✓" : "⧉"}
      </button>
    </span>
  );
}

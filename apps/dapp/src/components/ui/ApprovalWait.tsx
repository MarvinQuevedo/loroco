import { useEffect, useState } from "react";

// Prominent "the wallet popup is gating this call" banner with a live
// elapsed counter. Rendered while a write action is in its `approving`
// phase so the user knows the dApp is waiting on THEM, not stuck.
export function ApprovalWait({ active, label }: { active: boolean; label?: string }) {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!active) return;
    setSeconds(0);
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [active]);

  if (!active) return null;
  return (
    <div className="approval-wait" role="status" aria-live="polite">
      <span className="spinner" style={{ width: 18, height: 18, borderWidth: 2 }} />
      <div>
        <strong>{label ?? "Waiting for wallet approval…"}</strong>
        <div className="approval-wait-sub">
          Review the request in the Loroco popup — nothing is signed or sent until you approve
          there. <span className="mono">{seconds}s</span>
        </div>
      </div>
    </div>
  );
}

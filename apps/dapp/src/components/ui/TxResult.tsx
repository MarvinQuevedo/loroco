import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CopyText } from "./CopyText";

// Success banner after a broadcast. Shows the tx id verbatim (copyable)
// and points at Activity, where the pending watcher tracks confirmation.
export function TxResult({
  id,
  title = "Submitted to the network",
  children,
}: {
  /** Transaction / spend-bundle id. Some handlers return {} — pass null then. */
  id: string | null | undefined;
  title?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="note success" data-testid="tx-result">
      <strong>✓ {title}</strong>
      {id && (
        <div style={{ margin: "8px 0 4px" }}>
          <CopyText text={id} />
        </div>
      )}
      {children}
      <div style={{ marginTop: 6, fontSize: 12 }}>
        Watch it confirm in <Link to="/activity">Activity</Link> — the badge up top tracks pending
        transactions live.
      </div>
    </div>
  );
}

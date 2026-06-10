import { useCallback, useEffect, useState } from "react";
import type { TransactionView } from "@ozone/goby-provider/types";
import { PageHead } from "../../components/layout/AppShell";
import { Button, Card, CopyText, EmptyState, Spinner } from "../../components/ui";
import { useProvider } from "../../provider/useProvider";
import { usePendingTx } from "../../provider/PendingTxContext";
import { mojosToCat, mojosToXch } from "../../lib/mojos";
import { shortenHex, timeAgo } from "../../lib/format";

const AUTO_REFRESH_MS = 15_000;

// Tx history with live refresh. The global pending watcher already toasts
// confirmations; this view re-reads whenever the pending set changes so the
// table flips pending → confirmed without a manual refresh.
export default function Activity() {
  const { call, connected } = useProvider();
  const { pending } = usePendingTx();
  const [txs, setTxs] = useState<TransactionView[] | null>(null);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      setTxs(await call("getTransactions", { limit: 200, offset: 0, pendingOnly }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [call, connected, pendingOnly]);

  // Initial + filter changes + whenever the global pending set shrinks/grows.
  useEffect(() => {
    void load();
  }, [load, pending.length]);

  // Slow background refresh keeps heights/timestamps current.
  useEffect(() => {
    const t = setInterval(() => void load(), AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
      <PageHead title="Activity" blurb="Transaction history — refreshes automatically." />

      <Card
        title="Transactions"
        actions={
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center" }}>
            <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={pendingOnly}
                onChange={(e) => setPendingOnly(e.target.checked)}
              />
              pending only
            </label>
            <Button variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
              ↻ Refresh
            </Button>
          </span>
        }
      >
        {error && <div className="note danger">{error}</div>}
        {txs === null ? (
          <Spinner label="Reading history…" />
        ) : txs.length === 0 ? (
          <EmptyState icon="📜" title={pendingOnly ? "Nothing pending" : "No transactions yet"}>
            {pendingOnly
              ? "Broadcast something — it will appear here within seconds."
              : "Incoming and outgoing coins show up here as the sync sees them."}
          </EmptyState>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl" data-testid="tx-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Tx / coin id</th>
                  <th>Asset</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th className="num">Height</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={`${t.id}-${t.direction}`}>
                    <td title={t.direction}>{t.direction === "incoming" ? "↓" : "↑"}</td>
                    <td>
                      <CopyText text={t.id} display={shortenHex(t.id)} />
                    </td>
                    <td>
                      {t.asset.type === "cat" && t.asset.assetId ? (
                        <CopyText text={t.asset.assetId} display={shortenHex(t.asset.assetId)} />
                      ) : (
                        "XCH"
                      )}
                    </td>
                    <td
                      className="num mono"
                      style={{ color: t.direction === "incoming" ? "var(--green)" : undefined }}
                    >
                      {t.direction === "incoming" ? "+" : "−"}
                      {t.asset.type === "cat" ? mojosToCat(t.amount) : mojosToXch(t.amount)}
                    </td>
                    <td>
                      {t.status === "pending" ? (
                        <span className="tag tag-write">pending</span>
                      ) : (
                        <span className="tag tag-read">confirmed</span>
                      )}
                    </td>
                    <td className="num">{t.height ?? "—"}</td>
                    <td>{timeAgo(t.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

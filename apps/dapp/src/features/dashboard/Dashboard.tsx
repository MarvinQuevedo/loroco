import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../components/layout/AppShell";
import { Button, Card, CopyText, Qr, Spinner, Stat } from "../../components/ui";
import { useProvider } from "../../provider/useProvider";
import { describeError } from "../../provider/client";
import { mojosToXch } from "../../lib/mojos";
import { explorerUrl, fmtNumber } from "../../lib/format";
import { normalizeNftsResult } from "../../lib/nft";

interface DashData {
  xchConfirmed: string;
  xchSpendable: string;
  spendableCoins: number;
  cats: number | null;
  nfts: number | null;
  offers: number | null;
  dids: number | null;
  pubKeys: number | null;
}

// `getCats` enriches via Dexie and can lag right after unlock; counts that
// come back null just render "—" and a refresh re-reads.
export default function Dashboard() {
  const { call, account, chainId, scope } = useProvider();
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bal, cats, nfts, offers, dids, keys] = await Promise.allSettled([
        call("getAssetBalance", { type: null, assetId: null }),
        call("getCats", { limit: 200, offset: 0 }),
        call("getNFTs", { limit: 200, offset: 0 }),
        call("getOffers", { limit: 200, offset: 0 }),
        call("getDids", { limit: 200, offset: 0 }),
        call("getPublicKeys", { limit: 50, offset: 0 }),
      ]);
      const balVal = bal.status === "fulfilled" ? bal.value : null;
      setData({
        xchConfirmed: balVal ? mojosToXch(balVal.confirmed) : "—",
        xchSpendable: balVal ? mojosToXch(balVal.spendable) : "—",
        spendableCoins: balVal ? balVal.spendableCoinCount : 0,
        cats: cats.status === "fulfilled" ? cats.value.length : null,
        nfts: nfts.status === "fulfilled" ? normalizeNftsResult(nfts.value).length : null,
        offers: offers.status === "fulfilled" ? offers.value.length : null,
        dids: dids.status === "fulfilled" ? dids.value.length : null,
        pubKeys: keys.status === "fulfilled" ? keys.value.length : null,
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  const count = (n: number | null) => (n == null ? "—" : fmtNumber(n));

  // A connected wallet with zero balance AND zero coins is almost always still
  // syncing — not empty. Surface that instead of letting the user read "0"
  // everywhere and assume the wallet is broken.
  const looksUnsynced =
    !!data &&
    data.spendableCoins === 0 &&
    (data.xchConfirmed === "0" || data.xchConfirmed === "—") &&
    (data.nfts ?? 0) === 0 &&
    (data.cats ?? 0) === 0;

  const addrUrl = account ? explorerUrl("address", account, chainId) : null;

  return (
    <>
      <PageHead title="Dashboard" blurb="Live balance, network and at-a-glance counts." />

      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <Button onClick={() => void load()} loading={loading} variant="ghost">
          ↻ Refresh
        </Button>
        {scope === "read-only" && <span className="tag tag-read">read-only connection</span>}
      </div>

      {error && <div className="note danger">{error}</div>}

      {looksUnsynced && (
        <div className="note info">
          <span className="sync-banner">
            <span className="spinner" />
            <span>
              Balances read <strong>0</strong> across the board — the wallet is likely still
              syncing coins. This can take a few minutes after unlock; hit Refresh once it catches
              up.
            </span>
          </span>
        </div>
      )}

      {loading && !data ? (
        <Card>
          <Spinner label="Reading wallet…" />
        </Card>
      ) : (
        <>
          <div className="grid grid-stats" data-testid="dash-stats">
            <Stat label="Network" value={chainId ?? "—"} />
            <Stat label="XCH (confirmed)" value={data?.xchConfirmed ?? "—"} />
            <Stat label="XCH (spendable)" value={data?.xchSpendable ?? "—"} />
            <Stat label="Spendable coins" value={fmtNumber(data?.spendableCoins ?? 0)} />
            <Stat label="CATs" value={count(data?.cats ?? null)} />
            <Stat label="NFTs" value={count(data?.nfts ?? null)} />
            <Stat label="Offers" value={count(data?.offers ?? null)} />
            <Stat label="DIDs" value={count(data?.dids ?? null)} />
            <Stat label="Public keys" value={count(data?.pubKeys ?? null)} />
          </div>

          <Card title="Receive address">
            {account ? (
              <div className="receive-row">
                <Qr data={account} />
                <div className="receive-meta">
                  <CopyText text={account} />
                  <span style={{ fontSize: 13, color: "var(--muted)" }}>
                    Scan to receive XCH, CATs or NFTs at this wallet.
                    {addrUrl && (
                      <>
                        {" · "}
                        <a href={addrUrl} target="_blank" rel="noopener noreferrer">
                          View on Spacescan ↗
                        </a>
                      </>
                    )}
                  </span>
                </div>
              </div>
            ) : (
              <span style={{ color: "var(--muted)" }}>No address (read-only or not exposed).</span>
            )}
          </Card>
        </>
      )}
    </>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AssetType, CoinView } from "@ozone/goby-provider/types";
import { PageHead } from "../../components/layout/AppShell";
import {
  Button,
  Card,
  CopyText,
  EmptyState,
  Field,
  JsonView,
  Select,
  Spinner,
  Stat,
  TextArea,
  TextInput,
} from "../../components/ui";
import { useProvider } from "../../provider/useProvider";
import { mojosToCat, mojosToXch } from "../../lib/mojos";
import { fmtNumber, shortenHex } from "../../lib/format";
import { isHex32 } from "../../lib/hex";

export default function Coins() {
  return (
    <>
      <PageHead title="Coins" blurb="Coin explorer with client-side balance analysis." />
      <ExplorerCard />
      <LookupByIdsCard />
      <OwnershipCard />
    </>
  );
}

function fmtAmount(c: CoinView): string {
  if (c.assetType === "cat") return `${mojosToCat(c.amount)} CAT`;
  if (c.assetType === "nft") return "NFT";
  return `${mojosToXch(c.amount)} XCH`;
}

function ExplorerCard() {
  const { call, connected } = useProvider();
  const [type, setType] = useState<"" | "cat" | "nft">("");
  const [includeSpent, setIncludeSpent] = useState(false);
  const [coins, setCoins] = useState<CoinView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // coin ids confirmed unlocked by filterUnlockedCoins (null = not checked).
  const [unlocked, setUnlocked] = useState<Set<string> | null>(null);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    setUnlocked(null);
    try {
      setCoins(
        await call("getCoins", {
          ...(type ? { type: type as AssetType } : {}),
          limit: 500,
          offset: 0,
          includeSpent,
        }),
      );
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [call, connected, type, includeSpent]);

  useEffect(() => {
    void load();
  }, [load]);

  const checkLocks = async () => {
    if (!coins || coins.length === 0) return;
    setChecking(true);
    try {
      const ids = coins.filter((c) => !c.spent).map((c) => c.coinId);
      const free = await call("filterUnlockedCoins", { coinNames: ids });
      setUnlocked(new Set(free));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setChecking(false);
    }
  };

  // Client-side distribution analysis over the loaded set.
  const stats = useMemo(() => {
    if (!coins) return null;
    const xch = coins.filter((c) => c.assetType === "xch" && !c.spent);
    let total = 0n;
    let largest = 0n;
    let dust = 0;
    for (const c of xch) {
      const v = BigInt(c.amount);
      total += v;
      if (v > largest) largest = v;
      if (v < 1_000_000n) dust += 1; // < 0.000001 XCH
    }
    return {
      unspent: coins.filter((c) => !c.spent).length,
      pending: coins.filter((c) => c.pending).length,
      xchTotal: mojosToXch(total),
      largest: mojosToXch(largest),
      dust,
    };
  }, [coins]);

  return (
    <Card
      title="Coin explorer"
      actions={
        <span style={{ display: "inline-flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <Select value={type} onChange={(e) => setType(e.target.value as "" | "cat" | "nft")} style={{ width: 120 }}>
            <option value="">XCH</option>
            <option value="cat">CAT</option>
            <option value="nft">NFT</option>
          </Select>
          <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={includeSpent}
              onChange={(e) => setIncludeSpent(e.target.checked)}
            />
            include spent
          </label>
          <Button variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
            ↻ Refresh
          </Button>
        </span>
      }
    >
      {error && <div className="note danger">{error}</div>}

      {stats && (
        <div className="grid grid-stats" style={{ marginBottom: 14 }}>
          <Stat label="Unspent coins" value={fmtNumber(stats.unspent)} />
          <Stat label="Pending spends" value={fmtNumber(stats.pending)} />
          <Stat label="XCH total (loaded)" value={stats.xchTotal} />
          <Stat label="Largest coin" value={stats.largest} />
          <Stat label="Dust coins" value={fmtNumber(stats.dust)} />
        </div>
      )}

      {coins === null ? (
        <Spinner label="Reading coins…" />
      ) : coins.length === 0 ? (
        <EmptyState icon="🔎" title="No coins match this filter" />
      ) : (
        <>
          <div className="form-actions" style={{ marginTop: 0, marginBottom: 10 }}>
            <Button variant="ghost" size="sm" loading={checking} onClick={() => void checkLocks()}>
              Check offer-locks (filterUnlockedCoins)
            </Button>
            {unlocked && (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {unlocked.size} unlocked / {coins.filter((c) => !c.spent).length} unspent
              </span>
            )}
          </div>
          <div className="tbl-wrap">
            <table className="tbl" data-testid="coins-table">
              <thead>
                <tr>
                  <th>Coin id</th>
                  <th>Asset</th>
                  <th className="num">Amount</th>
                  <th className="num">Height</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {coins.slice(0, 100).map((c) => (
                  <tr key={c.coinId}>
                    <td>
                      <CopyText text={c.coinId} display={shortenHex(c.coinId)} />
                    </td>
                    <td>
                      {c.assetId ? (
                        <CopyText text={c.assetId} display={shortenHex(c.assetId)} />
                      ) : (
                        "XCH"
                      )}
                    </td>
                    <td className="num mono">{fmtAmount(c)}</td>
                    <td className="num">{c.confirmedBlockIndex || "—"}</td>
                    <td>
                      {c.spent ? (
                        <span className="tag tag-stub">spent</span>
                      ) : c.pending ? (
                        <span className="tag tag-write">pending spend</span>
                      ) : unlocked && !unlocked.has(c.coinId) ? (
                        <span className="tag tag-write">offer-locked</span>
                      ) : (
                        <span className="tag tag-read">spendable</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {coins.length > 100 && (
            <div className="note info" style={{ marginBottom: 0 }}>
              Showing the first 100 of {coins.length} loaded coins.
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function LookupByIdsCard() {
  const { call } = useProvider();
  const [ids, setIds] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CoinView[] | null>(null);

  const run = async () => {
    setError(null);
    setResult(null);
    const list = ids
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0 || list.some((id) => !isHex32(id))) {
      setError("Enter one or more 64-char hex coin ids (newline or comma separated)");
      return;
    }
    setLoading(true);
    try {
      setResult(await call("getCoinsByIds", { coinIds: list }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Resolve coins by id">
      <Field label="Coin ids" hint="Unknown ids are silently omitted from the result.">
        <TextArea
          value={ids}
          onChange={(e) => setIds(e.target.value)}
          placeholder={"coin id per line…"}
          rows={3}
          spellCheck={false}
        />
      </Field>
      <div className="form-actions">
        <Button onClick={() => void run()} loading={loading}>
          Resolve
        </Button>
        {result && (
          <span style={{ fontSize: 13, color: "var(--muted)" }}>{result.length} coin(s) found</span>
        )}
      </div>
      {error && <div className="note danger">{error}</div>}
      {result && <JsonView value={result} label="Coins" />}
    </Card>
  );
}

function OwnershipCard() {
  const { call } = useProvider();
  const [type, setType] = useState<"cat" | "nft" | "did">("cat");
  const [assetId, setAssetId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [owned, setOwned] = useState<boolean | null>(null);

  const run = async () => {
    setError(null);
    setOwned(null);
    if (!isHex32(assetId)) {
      setError("Asset id must be 32 bytes of hex");
      return;
    }
    setLoading(true);
    try {
      setOwned(await call("isAssetOwned", { type, assetId: assetId.trim() }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="Ownership check">
      <div className="row-line">
        <span style={{ width: 110, flex: "none" }}>
          <Select value={type} onChange={(e) => setType(e.target.value as "cat" | "nft" | "did")}>
            <option value="cat">CAT</option>
            <option value="nft">NFT</option>
            <option value="did">DID</option>
          </Select>
        </span>
        <span className="grow">
          <TextInput
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
            placeholder="Asset id / launcher id (64-char hex)"
            spellCheck={false}
          />
        </span>
        <Button onClick={() => void run()} loading={loading}>
          Check
        </Button>
      </div>
      {error && <div className="note danger">{error}</div>}
      {owned !== null && (
        <div className={`note ${owned ? "success" : "warn"}`} style={{ marginBottom: 0 }}>
          {owned
            ? "✓ The wallet owns at least one unspent coin of this asset."
            : "The wallet does not own this asset."}
        </div>
      )}
    </Card>
  );
}

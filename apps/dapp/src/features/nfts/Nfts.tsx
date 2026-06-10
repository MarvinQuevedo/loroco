import { useCallback, useEffect, useState } from "react";
import type { ChiaMethodMap, DidInfo } from "@ozone/goby-provider/types";
import { PageHead } from "../../components/layout/AppShell";
import {
  ApprovalWait,
  Button,
  Card,
  CopyText,
  EmptyState,
  Field,
  JsonView,
  Select,
  Spinner,
  TextInput,
  TxResult,
} from "../../components/ui";
import { useProvider } from "../../provider/useProvider";
import { useWriteAction } from "../../provider/useWriteAction";
import { normalizeNftsResult, type NormalizedNft } from "../../lib/nft";
import { shortenHex } from "../../lib/format";
import { isHex32 } from "../../lib/hex";
import { xchToMojos } from "../../lib/mojos";

export default function Nfts() {
  return (
    <>
      <PageHead title="NFTs" blurb="Owned NFTs, lookup, bulk mint and URI append." />
      <NftGridCard />
      <NftInfoCard />
      <AddUriCard />
      <BulkMintCard />
    </>
  );
}

function NftGridCard() {
  const { call, connected } = useProvider();
  const [nfts, setNfts] = useState<NormalizedNft[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setError(null);
    try {
      const res = await call("getNFTs", { limit: 200, offset: 0 });
      setNfts(normalizeNftsResult(res));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  }, [call, connected]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card
      title="Owned NFTs"
      actions={
        <Button variant="ghost" size="sm" loading={loading} onClick={() => void load()}>
          ↻ Refresh
        </Button>
      }
    >
      {error && <div className="note danger">{error}</div>}
      {nfts === null ? (
        <Spinner label="Reading NFTs…" />
      ) : nfts.length === 0 ? (
        <EmptyState icon="🖼️" title="No NFTs">
          NFTs owned by this wallet show up here once the coin sync sees them.
        </EmptyState>
      ) : (
        <div className="nft-grid" data-testid="nft-grid">
          {nfts.map((n) => (
            <NftCard key={n.launcherId} nft={n} />
          ))}
        </div>
      )}
    </Card>
  );
}

function NftCard({ nft }: { nft: NormalizedNft }) {
  const [imgFailed, setImgFailed] = useState(false);
  return (
    <div className="nft-card">
      {nft.image && !imgFailed ? (
        <img className="nft-img" src={nft.image} alt={nft.name ?? "NFT"} onError={() => setImgFailed(true)} />
      ) : (
        <div className="nft-img-fallback" aria-hidden>
          🖼️
        </div>
      )}
      <div className="nft-body">
        <strong>{nft.name ?? shortenHex(nft.launcherId)}</strong>
        {nft.editionNumber != null && nft.editionTotal != null && (
          <span style={{ color: "var(--muted)" }}>
            Edition {nft.editionNumber}/{nft.editionTotal}
          </span>
        )}
        {nft.royaltyTenThousandths != null && nft.royaltyTenThousandths > 0 && (
          <span style={{ color: "var(--muted)" }}>
            Royalty {(nft.royaltyTenThousandths / 100).toFixed(2)}%
          </span>
        )}
        <CopyText text={nft.launcherId} display={shortenHex(nft.launcherId)} />
      </div>
    </div>
  );
}

function NftInfoCard() {
  const { call } = useProvider();
  const [id, setId] = useState("");
  const [kind, setKind] = useState<"launcherId" | "coinId">("launcherId");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ChiaMethodMap["getNFTInfo"]["result"] | undefined>(undefined);

  const run = async () => {
    setError(null);
    setResult(undefined);
    if (!isHex32(id)) {
      setError("Expecting 32 bytes of hex (64 chars)");
      return;
    }
    setLoading(true);
    try {
      setResult(
        await call(
          "getNFTInfo",
          kind === "launcherId" ? { launcherId: id.trim() } : { coinId: id.trim() },
        ),
      );
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="NFT lookup">
      <div className="row-line">
        <span style={{ width: 140, flex: "none" }}>
          <Select value={kind} onChange={(e) => setKind(e.target.value as "launcherId" | "coinId")}>
            <option value="launcherId">launcher id</option>
            <option value="coinId">coin id</option>
          </Select>
        </span>
        <span className="grow">
          <TextInput
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="64-char hex"
            spellCheck={false}
          />
        </span>
        <Button onClick={() => void run()} loading={loading}>
          Lookup
        </Button>
      </div>
      {error && <div className="note danger">{error}</div>}
      {result === null && <div className="note warn">The wallet doesn't track that NFT.</div>}
      {result && <JsonView value={result} label="NFT info" />}
    </Card>
  );
}

function AddUriCard() {
  const action = useWriteAction("addNftUri", { successMsg: "URI appended — NFT re-spent" });
  const [launcherId, setLauncherId] = useState("");
  const [uriKind, setUriKind] = useState<"data" | "metadata" | "license">("data");
  const [uri, setUri] = useState("");
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    setFormError(null);
    try {
      if (!isHex32(launcherId)) throw new Error("Launcher id must be 32 bytes of hex");
      if (!/^https?:\/\/.+/.test(uri.trim()) && !uri.trim().startsWith("ipfs://")) {
        throw new Error("URI should be http(s):// or ipfs://");
      }
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      await action
        .run({
          launcherId: launcherId.trim(),
          uriKind,
          uri: uri.trim(),
          ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}),
        })
        .catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Append a URI">
      <div className="note info" style={{ marginTop: 0 }}>
        Re-spends the NFT to its current owner with the new URI added — ownership doesn't change.
      </div>
      <div className="form-grid">
        <div className="span-2">
          <Field label="NFT launcher id">
            <TextInput
              value={launcherId}
              onChange={(e) => setLauncherId(e.target.value)}
              placeholder="64-char hex"
              spellCheck={false}
              disabled={action.busy}
            />
          </Field>
        </div>
        <Field label="List">
          <Select
            value={uriKind}
            onChange={(e) => setUriKind(e.target.value as "data" | "metadata" | "license")}
            disabled={action.busy}
          >
            <option value="data">data (image / file)</option>
            <option value="metadata">metadata (attributes)</option>
            <option value="license">license</option>
          </Select>
        </Field>
        <Field label="Fee (XCH)" hint="Optional.">
          <TextInput
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            disabled={action.busy}
          />
        </Field>
        <div className="span-2">
          <Field label="URI">
            <TextInput
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              placeholder="https://… or ipfs://…"
              spellCheck={false}
              disabled={action.busy}
            />
          </Field>
        </div>
      </div>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the URI append in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <TxResult id={action.result.id} title="URI appended" />
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}

interface MintRow {
  dataUri: string;
  address: string;
}

function BulkMintCard() {
  const { call, connected } = useProvider();
  const action = useWriteAction("bulkMintNfts", {
    successMsg: (r) => `Minted ${r.nftIds.length} NFT(s)`,
  });
  const [dids, setDids] = useState<DidInfo[]>([]);
  const [didId, setDidId] = useState("");
  const [rows, setRows] = useState<MintRow[]>([{ dataUri: "", address: "" }]);
  const [royaltyAddress, setRoyaltyAddress] = useState("");
  const [royaltyPct, setRoyaltyPct] = useState("");
  const [fee, setFee] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    call("getDids", { limit: 100, offset: 0 })
      .then(setDids)
      .catch(() => setDids([]));
  }, [call, connected]);

  const selectedDid = dids.find((d) => d.launcherId === didId) ?? dids[0] ?? null;

  const update = (i: number, patch: Partial<MintRow>) =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = async () => {
    setFormError(null);
    try {
      if (!selectedDid) throw new Error("Mint requires a confirmed DID — create one in the DIDs tab first");
      if (selectedDid.derivationIndex == null) {
        throw new Error("The selected DID has no derivation index tracked — only locally-minted DIDs can mint for now");
      }
      const filled = rows.filter((r) => r.dataUri.trim() !== "");
      if (filled.length === 0) throw new Error("Add at least one NFT with a data URI");
      const total = filled.length;
      const nfts = filled.map((r, i) => ({
        ...(r.address.trim() ? { address: r.address.trim() } : {}),
        dataUris: [r.dataUri.trim()],
        ...(royaltyAddress.trim() ? { royaltyAddress: royaltyAddress.trim() } : {}),
        ...(royaltyPct.trim()
          ? { royaltyTenThousandths: Math.round(parseFloat(royaltyPct) * 100) }
          : {}),
        editionNumber: i + 1,
        editionTotal: total,
      }));
      const feeMojos = fee.trim() ? xchToMojos(fee) : 0n;
      // didCoinId/didDerivationIndex are extra params the handler requires
      // until Fase 3 DID tracking resolves them from the launcher id alone.
      const params = {
        did: selectedDid.launcherId,
        nfts,
        ...(feeMojos > 0n ? { fee: feeMojos.toString() } : {}),
        didCoinId: selectedDid.coinId,
        didDerivationIndex: selectedDid.derivationIndex,
      } as unknown as ChiaMethodMap["bulkMintNfts"]["params"];
      await action.run(params).catch(() => {});
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card title="Bulk mint">
      {dids.length === 0 && (
        <div className="note warn" style={{ marginTop: 0 }}>
          No DIDs tracked — minting needs one. Create it in the <strong>DIDs</strong> tab and wait
          for it to confirm.
        </div>
      )}
      <div className="form-grid">
        <Field label="Minter DID">
          <Select
            value={selectedDid?.launcherId ?? ""}
            onChange={(e) => setDidId(e.target.value)}
            disabled={action.busy || dids.length === 0}
          >
            {dids.length === 0 && <option value="">No DIDs available</option>}
            {dids.map((d) => (
              <option key={d.launcherId} value={d.launcherId}>
                {d.name || shortenHex(d.launcherId)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fee (XCH)" hint="Optional.">
          <TextInput
            value={fee}
            onChange={(e) => setFee(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            disabled={action.busy}
          />
        </Field>
        <Field label="Royalty address" hint="Optional — applies to every minted NFT.">
          <TextInput
            value={royaltyAddress}
            onChange={(e) => setRoyaltyAddress(e.target.value)}
            placeholder="xch1…"
            spellCheck={false}
            disabled={action.busy}
          />
        </Field>
        <Field label="Royalty %" hint="Optional — e.g. 2.5">
          <TextInput
            value={royaltyPct}
            onChange={(e) => setRoyaltyPct(e.target.value)}
            placeholder="0"
            inputMode="decimal"
            disabled={action.busy}
          />
        </Field>
      </div>

      <Field label="NFTs to mint">
        <div className="row-list">
          {rows.map((row, i) => (
            <div className="row-line" key={i}>
              <span className="grow">
                <TextInput
                  value={row.dataUri}
                  onChange={(e) => update(i, { dataUri: e.target.value })}
                  placeholder={`NFT ${i + 1} data URI — https://… or ipfs://…`}
                  spellCheck={false}
                  disabled={action.busy}
                />
              </span>
              <span className="grow">
                <TextInput
                  value={row.address}
                  onChange={(e) => update(i, { address: e.target.value })}
                  placeholder="Recipient (optional — defaults to you)"
                  spellCheck={false}
                  disabled={action.busy}
                />
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="row-remove"
                disabled={action.busy || rows.length === 1}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                ✕
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="ghost"
              size="sm"
              disabled={action.busy}
              onClick={() => setRows([...rows, { dataUri: "", address: "" }])}
            >
              + Add NFT
            </Button>
          </div>
        </div>
      </Field>

      {formError && <div className="note danger">{formError}</div>}
      {action.error && <div className="note danger">{action.error}</div>}
      <ApprovalWait active={action.busy} label="Confirm the mint in the Loroco popup…" />
      {action.phase === "success" && action.result && (
        <div className="note success">
          <strong>✓ Minted {action.result.nftIds.length} NFT(s)</strong>
          <JsonView value={action.result.nftIds} label="NFT ids" />
        </div>
      )}

      <div className="form-actions">
        <Button onClick={() => void submit()} loading={action.busy} disabled={dids.length === 0}>
          Review in wallet →
        </Button>
      </div>
    </Card>
  );
}

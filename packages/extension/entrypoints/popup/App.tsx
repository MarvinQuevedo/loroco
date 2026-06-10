import { useEffect, useState, type ReactNode } from "react";
import {
  analyzeCoinSpends,
  cacheHardenedPhs,
  callEngine,
  decideApproval,
  forceCoinSync,
  getCoinSnapshot,
  getCoinSyncTelemetry,
  getCompatSettings,
  getMempoolDebug,
  getNotifSettings,
  getSidecarSettings,
  getSyncState,
  getXchPriceUsd,
  listConnections,
  listPendingApprovals,
  pickCoinsForSendMulti,
  probeSidecar,
  revokeConnection,
  setActiveWallet,
  setCompatSettings,
  setNotifSettings,
  setSidecarSettings,
  type CoinSnapshot,
  type CoinSpendAnalysis,
  type CompatSettings,
  type NotifSettings,
  type CoinSyncTelemetry,
  type ConnectionRecord,
  type DexieCatMetadata,
  type MempoolDebugEntry,
  type MempoolDebugSnapshot,
  type NftView,
  type PendingApproval,
  type SendXchResult,
  type SidecarProbe,
  type SidecarSettings,
  type StageProgress,
  type SyncStage,
  type SyncState,
} from "../../src/popup/engine-client";
import {
  getDerivationState,
  setActiveIndex,
  setLabel,
} from "../../src/popup/derivation-store";
import { Qr } from "../../src/popup/qr";
import {
  getActiveFingerprint,
  getActiveTab,
  listWallets,
  removeWallet,
  saveWallet,
  setActiveFingerprint,
  setActiveTab,
  type StoredWallet,
} from "../../src/popup/wallet-store";

type TabName =
  | "home"
  | "send"
  | "receive"
  | "nfts"
  | "activity"
  | "dev"
  | "settings"
  | "status";

const VALID_TABS: readonly TabName[] = [
  "home",
  "send",
  "receive",
  "nfts",
  "activity",
  "dev",
  "settings",
  "status",
];

function isTabName(s: string | null): s is TabName {
  return s != null && (VALID_TABS as readonly string[]).includes(s);
}

type View =
  | { kind: "loading" }
  | { kind: "onboarding"; cancellable: boolean }
  | { kind: "locked"; wallet: StoredWallet; wallets: StoredWallet[] }
  | { kind: "home"; wallet: StoredWallet; wallets: StoredWallet[] };

export function App() {
  const [view, setView] = useState<View>({ kind: "loading" });
  const [tab, setTabState] = useState<TabName>("home");

  // Keep-alive port: while this popup is open, Chrome must NOT kill the SW
  // mid-CAT-scan. Opening a long-lived port + sending a heartbeat every 20s
  // is the standard MV3 keep-alive trick. The SW has a matching onConnect
  // listener that just accepts the messages.
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const connect = () => {
      try {
        port = chrome.runtime.connect({ name: "loroco-keepalive" });
        port.onDisconnect.addListener(() => {
          // SW recycled — reconnect on next heartbeat tick.
          port = null;
        });
      } catch {
        port = null;
      }
    };
    connect();
    intervalId = setInterval(() => {
      if (!port) connect();
      try {
        port?.postMessage({ ping: Date.now() });
        console.log("[popup-heartbeat]", new Date().toISOString());
      } catch {
        port = null;
      }
    }, 5_000);
    return () => {
      if (intervalId) clearInterval(intervalId);
      try {
        port?.disconnect();
      } catch {
        // ignore
      }
    };
  }, []);

  // dApp approval queue. When non-empty, the inline ApprovalScreen takes over
  // the popup body until the user approves/rejects. Polled on mount + every
  // 1s while the popup is open so a fresh request arriving from another tab
  // surfaces here within a second.
  const [pending, setPending] = useState<PendingApproval[]>([]);

  // Restore last tab on first mount
  useEffect(() => {
    void getActiveTab().then((t) => {
      if (isTabName(t)) setTabState(t);
    });
  }, []);

  // Poll pending approvals.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await listPendingApprovals();
        if (!cancelled) setPending(list);
      } catch {
        // best-effort
      }
    };
    void refresh();
    const id = setInterval(refresh, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const decide = async (
    id: string,
    approved: boolean,
    overrides?: Record<string, unknown>,
  ) => {
    try {
      await decideApproval(id, approved, overrides);
    } finally {
      setPending((p) => {
        const next = p.filter((r) => r.id !== id);
        // Once the queue drains, close the popup so the user is NOT left
        // staring at the wallet (which they didn't open — the dApp did).
        // If more approvals remain queued, keep the popup open to walk
        // through the rest.
        if (next.length === 0) {
          try { window.close(); } catch { /* sandbox may block */ }
        }
        return next;
      });
    }
  };

  const setTab = (next: TabName) => {
    setTabState(next);
    void setActiveTab(next).catch(() => {});
  };

  const refresh = async (preferFp?: number) => {
    const wallets = await listWallets();
    if (wallets.length === 0) {
      setView({ kind: "onboarding", cancellable: false });
      return;
    }
    const activeFp = preferFp ?? (await getActiveFingerprint());
    const target =
      (activeFp ? wallets.find((w) => w.fingerprint === activeFp) : null) ?? wallets[0]!;

    if (activeFp === target.fingerprint) {
      try {
        const res = await callEngine<{ unlocked: boolean }>("is_unlocked", {
          fingerprint: target.fingerprint,
        });
        if (res.unlocked) {
          await setActiveWallet(target.fingerprint.toString());
          setView({ kind: "home", wallet: target, wallets });
          return;
        }
      } catch {
        // fall through to lock
      }
    }
    setView({ kind: "locked", wallet: target, wallets });
  };

  useEffect(() => {
    void refresh();
  }, []);

  const switchWallet = async (fp: number) => {
    await setActiveFingerprint(null); // force re-evaluation of unlock state
    const res = await callEngine<{ unlocked: boolean }>("is_unlocked", {
      fingerprint: fp,
    }).catch(() => ({ unlocked: false }));
    if (res.unlocked) {
      await setActiveFingerprint(fp);
      await setActiveWallet(fp.toString());
    }
    await refresh(fp);
  };

  const startAddWallet = () => {
    setView({ kind: "onboarding", cancellable: true });
  };

  const handleLock = async () => {
    if (view.kind !== "home") return;
    try {
      await callEngine("lock_keychain", { fingerprint: view.wallet.fingerprint });
    } catch {
      // best-effort
    }
    await setActiveFingerprint(null);
    await setActiveWallet(null);
    setView({ kind: "locked", wallet: view.wallet, wallets: view.wallets });
  };

  // If any dApp is waiting for approval, the popup pre-empts whatever tab
  // the user was on and shows ONLY the approval screen — no wallet chip,
  // no tabs, no settings/lock buttons. Goby/MetaMask-style: the dApp
  // interaction is its own self-contained dialog, and the user never sees
  // their wallet UI while a request is pending. Once the queue drains the
  // popup auto-closes (see `decide`).
  const showApproval = pending.length > 0 && view.kind === "home";

  // Hide the top header on lock/onboarding/loading — those screens render
  // their own hero (stacked lockup + h1) so a duplicate header brand crowds
  // the layout and steals vertical space from the welcome hero.
  const showHeader = view.kind === "home";

  return (
    <div className="ozone-popup">
      {showHeader && (
        <header className="ozone-header">
          <span className="brand-lockup brand-lockup--sm">
            <img src="/icon/128.png" alt="" className="brand-mark" />
            <span className="brand-word">loroco</span>
          </span>
          {!showApproval && (
            <HeaderWalletChip
              wallet={view.wallet}
              wallets={view.wallets}
              onSwitchWallet={switchWallet}
              onAddWallet={startAddWallet}
            />
          )}
          {!showApproval && (
            <div className="header-actions">
              <button
                className="icon-btn"
                onClick={() => void handleLock()}
                title="Lock wallet"
                aria-label="Lock wallet"
              >
                🔒
              </button>
              <button
                className={tab === "settings" ? "icon-btn active" : "icon-btn"}
                onClick={() => setTab(tab === "settings" ? "home" : "settings")}
                title="Settings"
                aria-label="Settings"
              >
                ⚙
              </button>
              <button
                className={tab === "status" ? "icon-btn active" : "icon-btn"}
                onClick={() => setTab(tab === "status" ? "home" : "status")}
                title="Status"
                aria-label="Status"
              >
                📊
              </button>
            </div>
          )}
          {showApproval && (
            <span className="ozone-meta">
              {pending.length > 1
                ? `${pending.length} pending`
                : pending[0]?.method ?? ""}
            </span>
          )}
        </header>
      )}
      <main>
        {showApproval && (
          <ApprovalScreen
            key={pending[0]!.id}
            request={pending[0]!}
            queueSize={pending.length}
            fingerprint={view.wallet.fingerprint}
            onDecide={decide}
          />
        )}
        {!showApproval && view.kind === "loading" && <LoadingScreen />}
        {!showApproval && view.kind === "onboarding" && (
          <OnboardingScreen
            onDone={async (w) => {
              await setActiveFingerprint(w.fingerprint);
              await setActiveWallet(w.fingerprint.toString());
              // Land on Home after onboarding, regardless of the prior persisted tab.
              await setActiveTab("home");
              const wallets = await listWallets();
              setView({ kind: "home", wallet: w, wallets });
            }}
            onCancel={view.cancellable ? () => void refresh() : undefined}
          />
        )}
        {!showApproval && view.kind === "locked" && (
          <LockScreen
            wallet={view.wallet}
            wallets={view.wallets}
            onSwitchWallet={switchWallet}
            onUnlocked={async (w) => {
              await setActiveFingerprint(w.fingerprint);
              await setActiveWallet(w.fingerprint.toString());
              const wallets = await listWallets();
              setView({ kind: "home", wallet: w, wallets });
            }}
          />
        )}
        {!showApproval && view.kind === "home" && (
          <HomeScreen
            wallet={view.wallet}
            wallets={view.wallets}
            tab={tab}
            setTab={setTab}
            onSwitchWallet={switchWallet}
            onAddWallet={startAddWallet}
            onLock={handleLock}
          />
        )}
      </main>
    </div>
  );
}

/**
 * Mirror of `normalizeRequestedScope` in background/permissions.ts — the
 * scope CEILING the dApp requested in its connect params. Cosmetic only: it
 * sets the popup's default + whether the choice is locked. The background
 * handler clamps authoritatively (clampScope), so drift here can never grant
 * more than the dApp requested.
 */
function requestedScopeFromParams(params: unknown): "full" | "read-only" {
  const p = params as { scope?: unknown; readOnly?: unknown } | null | undefined;
  if (p && typeof p === "object") {
    if (p.readOnly === true) return "read-only";
    const s =
      typeof p.scope === "string" ? p.scope.toLowerCase().replace(/[_\s]/g, "-") : "";
    if (s === "read-only" || s === "readonly" || s === "read") return "read-only";
  }
  return "full";
}

function ApprovalScreen({
  request,
  queueSize,
  fingerprint,
  onDecide,
}: {
  request: PendingApproval;
  queueSize: number;
  fingerprint: number | null;
  onDecide: (
    id: string,
    approved: boolean,
    overrides?: Record<string, unknown>,
  ) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  // signCoinSpends + sendTransaction trigger async decoding of the bundle
  // (see CoinSpendBreakdown). Until that completes the user has no idea
  // what the bundle does, so the Approve button is gated on this flag.
  // Reject is always available — the user can bail at any time.
  // Default true for methods that don't decode anything (connect, transfer,
  // etc. — those render synchronously).
  const needsDecode =
    request.method === "signCoinSpends" || request.method === "sendTransaction";
  const [analysisReady, setAnalysisReady] = useState(!needsDecode);
  // Per-method override state. `createOffer` lets the user override the fee
  // a dApp proposed (Goby's combined-swap default of ~100M+ mojos is rarely
  // what the user wants — most XCH transfers need 0 or 5_000_000 mojos).
  //
  // The canonical fee is mojos (what the handler receives), but the user edits
  // it in XCH — editing a 9-digit mojos string is hostile and inconsistent with
  // every other amount in this dialog. `feeOverride` holds the editable XCH
  // string; `feeOverrideMojos` is the BigInt-safe canonical we actually send.
  const initialFee =
    request.method === "createOffer" || request.method === "takeOffer"
      ? String(
          (request.params as { fee?: string | number } | null)?.fee ?? "0",
        )
      : null;
  const initialFeeXch = initialFee != null ? formatAmount(initialFee, 12) : null;
  const [feeOverride, setFeeOverride] = useState<string | null>(initialFeeXch);
  const feeOverrideMojos = feeOverride != null ? xchToMojosStr(feeOverride) : null;
  // #2 — connection scope. On a connect/requestAccounts approval the user
  // chooses whether the site gets full access (signing allowed, still
  // per-call approved) or read-only (it can see balances/assets but every
  // signing/mutating method is rejected outright — the "this dApp may never
  // request signing" mode). Default to full to preserve existing behaviour.
  const isConnectRequest =
    request.method === "connect" || request.method === "requestAccounts";
  // The dApp declares a scope ceiling in its connect params. If it asked for
  // read-only, the choice is LOCKED there (the user can't upgrade to write).
  // If it asked for full (or didn't ask), the user may downgrade to read-only.
  const requestedScope = requestedScopeFromParams(request.params);
  const scopeLocked = requestedScope === "read-only";
  const [scope, setScope] = useState<"full" | "read-only">(requestedScope);
  // #1 — when the decoded bundle contains effects Loroco can't fully account
  // for (unrecognised puzzles, value leaving via an unknown layer, or a
  // replayable AGG_SIG_UNSAFE), the breakdown reports it here. We then force
  // an explicit acknowledgement checkbox before Approve unlocks, so a
  // "1 coin spend" summary can never get blind-approved when the contents
  // are opaque.
  const [riskAckRequired, setRiskAckRequired] = useState(false);
  const [riskAcked, setRiskAcked] = useState(false);

  const decide = async (approved: boolean) => {
    if (busy) return;
    setBusy(approved ? "approve" : "reject");
    try {
      const overrides: Record<string, unknown> = {};
      if (approved && feeOverrideMojos !== null && feeOverrideMojos !== initialFee) {
        overrides.fee = feeOverrideMojos;
      }
      if (approved && isConnectRequest) {
        overrides.scope = scope;
      }
      await onDecide(
        request.id,
        approved,
        Object.keys(overrides).length > 0 ? overrides : undefined,
      );
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="screen">
      {queueSize > 1 && (
        <div className="approval-queue muted small">
          {queueSize} requests pending — showing #1
        </div>
      )}
      <h1>{approvalTitle(request.method)}</h1>
      <p className="muted">
        <strong>{request.origin}</strong> is requesting permission.
      </p>

      <ApprovalSummary
        request={request}
        fingerprint={fingerprint}
        onAnalysisReady={setAnalysisReady}
        onRiskAssessed={setRiskAckRequired}
      />

      {isConnectRequest && scopeLocked && (
        <div className="scope-picker">
          <div className="scope-option selected scope-locked">
            <span className="scope-lock" aria-hidden>🔒</span>
            <span className="scope-body">
              <span className="scope-title">Read-only — requested by this site</span>
              <span className="muted small">
                This site asked for read-only access. It can see balances &amp;
                assets but can never sign or send, and this can't be upgraded
                here. Connect, then it stays read-only.
              </span>
            </span>
          </div>
        </div>
      )}

      {isConnectRequest && !scopeLocked && (
        <div className="scope-picker" role="radiogroup" aria-label="Connection access level">
          <label className={`scope-option ${scope === "full" ? "selected" : ""}`}>
            <input
              type="radio"
              name="connection-scope"
              value="full"
              checked={scope === "full"}
              onChange={() => setScope("full")}
              disabled={busy !== null}
            />
            <span className="scope-body">
              <span className="scope-title">Full access</span>
              <span className="muted small">
                Can request signing &amp; sending — you still approve each one.
              </span>
            </span>
          </label>
          <label className={`scope-option ${scope === "read-only" ? "selected" : ""}`}>
            <input
              type="radio"
              name="connection-scope"
              value="read-only"
              checked={scope === "read-only"}
              onChange={() => setScope("read-only")}
              disabled={busy !== null}
            />
            <span className="scope-body">
              <span className="scope-title">Read-only</span>
              <span className="muted small">
                See balances &amp; assets only. Signing/sending is blocked —
                it can never even ask. Reconnect later to grant more.
              </span>
            </span>
          </label>
        </div>
      )}

      {feeOverride !== null && (
        <div className="fee-override">
          <label htmlFor="fee-xch" className="muted small">
            Network fee (XCH) — dApp suggested{" "}
            <code>{fmtXch(initialFee ?? "0")}</code>:
          </label>
          <input
            id="fee-xch"
            type="number"
            min="0"
            step="0.0001"
            inputMode="decimal"
            value={feeOverride}
            onChange={(e) => setFeeOverride(e.target.value)}
            disabled={busy !== null}
          />
          {feeOverrideMojos !== initialFee && (
            <p className="muted small">
              You're overriding the fee (now <code>{fmtXch(feeOverrideMojos ?? "0")}</code>). The
              dApp may reject the offer if it expected a higher fee — try the suggested value first
              if unsure.
            </p>
          )}
        </div>
      )}

      <details>
        <summary>Raw params</summary>
        <pre className="params-raw">{JSON.stringify(request.params, null, 2)}</pre>
      </details>

      {riskAckRequired && (
        <label className="risk-ack">
          <input
            type="checkbox"
            checked={riskAcked}
            onChange={(e) => setRiskAcked(e.target.checked)}
            disabled={busy !== null}
          />
          <span>
            I understand this bundle has effects Loroco couldn't fully decode
            (an unrecognised puzzle, value leaving through an unknown layer, or
            a replayable signature) and I trust this site to sign it.
          </span>
        </label>
      )}

      <div className="row">
        <button
          className="secondary"
          disabled={busy !== null}
          onClick={() => void decide(false)}
        >
          {busy === "reject" ? "…" : "Reject"}
        </button>
        <button
          disabled={busy !== null || !analysisReady || (riskAckRequired && !riskAcked)}
          onClick={() => void decide(true)}
          title={
            !analysisReady
              ? "Waiting for the bundle to decode…"
              : riskAckRequired && !riskAcked
                ? "Tick the acknowledgement to enable Approve"
                : ""
          }
        >
          {busy === "approve" ? "…" : !analysisReady ? "Decoding…" : "Approve"}
        </button>
      </div>
    </section>
  );
}

function approvalTitle(method: string): string {
  switch (method) {
    case "connect":
    case "requestAccounts":
      return "Connect this site";
    case "signCoinSpends":
      return "Sign coin spends";
    case "signMessage":
      return "Sign message";
    case "signMessageByAddress":
      return "Sign message";
    case "transfer":
      return "Send transfer";
    case "sendTransaction":
      return "Send transaction";
    case "createOffer":
      return "Create offer";
    case "takeOffer":
      return "Take offer";
    case "cancelOffer":
      return "Cancel offer";
    case "walletSwitchChain":
      return "Switch network";
    case "walletWatchAsset":
      return "Add custom token";
    case "bulkSendXch":
      return "Send XCH to many";
    case "bulkSendCat":
      return "Send token to many";
    case "multiSend":
      return "Send to many (atomic)";
    case "combine":
      return "Combine coins";
    case "split":
      return "Split coin";
    case "issueCat":
      return "Mint new token (CAT)";
    case "createDid":
      return "Create DID profile";
    case "addNftUri":
      return "Add NFT URI";
    case "transferDid":
      return "Transfer DID";
    case "normalizeDids":
      return "Normalize DID";
    case "bulkMintNfts":
      return "Mint NFTs";
    default:
      return method;
  }
}

interface DecodedOfferLite {
  offered: { xch_mojos: string; cats: Array<{ asset_id: string; amount: string }>; nft_launcher_ids: string[] };
  requested: { xch_mojos: string; cats: Array<{ asset_id: string; amount: string }>; nft_launcher_ids: string[] };
  offered_royalties: Array<{
    nft_launcher_id: string;
    royalty_basis_points: number;
    /** On-chain royalty puzzle hash parsed from the offered NFT itself. */
    royalty_puzzle_hash?: string;
  }>;
  /** Royalty the taker pays, computed by the engine from the NFT's on-chain
   *  royalty info — not from the dApp's framing. */
  royalty_payment?: {
    xch_mojos: string;
    cats: Array<{ asset_id: string; amount: string }>;
  };
}

function TakeOfferSummary({
  offer,
  catDisplay,
}: {
  offer: string;
  catDisplay: (assetId: string | null | undefined) => CatDisplay;
}) {
  const [decoded, setDecoded] = useState<DecodedOfferLite | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await callEngine<DecodedOfferLite>("decode_offer", { offer });
        if (!cancelled) setDecoded(r);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [offer]);

  if (error) {
    return (
      <div className="result">
        <p className="error small">
          ⚠ This offer string is invalid or malformed — Loroco can't read what
          it would trade. Don't approve it.
        </p>
        <p className="muted small">Decoder said: {error}</p>
      </div>
    );
  }
  if (!decoded) {
    return <p className="muted small">Decoding offer…</p>;
  }

  // For takeOffer: the dApp's offer GIVES dApp's assets and ASKS for ours.
  // So `offered.*` on the on-wire offer is what we receive, `requested.*` is
  // what we pay. Frame it that way for the human reader.
  return (
    <div className="offer-summary">
      <div className="offer-side offer-receive">
        <span className="muted small">You receive</span>
        <OfferAssetList side={decoded.offered} catDisplay={catDisplay} />
      </div>
      <div className="offer-arrow" aria-hidden>↕</div>
      <div className="offer-side offer-pay">
        <span className="muted small">You pay</span>
        <OfferAssetList side={decoded.requested} catDisplay={catDisplay} />
      </div>
      {decoded.offered_royalties.length > 0 && <RoyaltyLine decoded={decoded} catDisplay={catDisplay} />}
    </div>
  );
}

/**
 * #3 — royalty disclosure for takeOffer. We show the percentage AND the
 * concrete amount the taker pays, computed by the engine from the offered
 * NFT's on-chain royalty puzzle hash + basis points (parsed from the NFT
 * coin spend in the bundle) — NOT from anything the dApp asserts. The
 * destination puzzle hash is shown and labelled "verified on-chain" so the
 * user can see funds go to the creator's real royalty address.
 */
function RoyaltyLine({
  decoded,
  catDisplay,
}: {
  decoded: DecodedOfferLite;
  catDisplay: (assetId: string | null | undefined) => CatDisplay;
}) {
  const pcts = decoded.offered_royalties
    .map((r) => `${(r.royalty_basis_points / 100).toFixed(2)}%`)
    .join(", ");
  const rp = decoded.royalty_payment;
  const amounts: string[] = [];
  if (rp) {
    if (BigInt(rp.xch_mojos) > 0n) amounts.push(fmtXch(rp.xch_mojos));
    for (const c of rp.cats) {
      if (BigInt(c.amount) > 0n) {
        const cd = catDisplay(c.asset_id);
        amounts.push(`${mojosToCatUnits(c.amount, cd.decimals)} ${cd.symbol ?? shortHash(c.asset_id)}`);
      }
    }
  }
  const phs = decoded.offered_royalties
    .map((r) => r.royalty_puzzle_hash)
    .filter((h): h is string => Boolean(h));
  return (
    <div className="royalty-note">
      <p className="muted small">
        Creator royalty: <strong>{pcts}</strong>
        {amounts.length > 0 ? (
          <>
            {" = "}
            <strong>{amounts.join(" + ")}</strong>
          </>
        ) : null}
      </p>
      {phs.length > 0 && (
        <p className="muted small">
          → <code title={phs.join(", ")}>{phs.map((h) => shortHash(h)).join(", ")}</code>{" "}
          <span
            className="verified-badge"
            title="Loroco re-derives this address and amount from the offered NFT's on-chain royalty puzzle, independent of what the site claims."
          >
            verified on-chain ✓
          </span>
        </p>
      )}
    </div>
  );
}

function OfferAssetList({
  side,
  catDisplay,
}: {
  side: DecodedOfferLite["offered"];
  catDisplay: (assetId: string | null | undefined) => CatDisplay;
}) {
  const xch = BigInt(side.xch_mojos);
  const items: string[] = [];
  if (xch > 0n) {
    items.push(fmtXch(xch.toString()));
  }
  for (const c of side.cats) {
    const cd = catDisplay(c.asset_id);
    items.push(`${mojosToCatUnits(c.amount, cd.decimals)} ${cd.symbol ?? shortHash(c.asset_id)}`);
  }
  for (const l of side.nft_launcher_ids) {
    items.push(`NFT ${shortHash(l)}`);
  }
  if (items.length === 0) return <span className="muted small">nothing</span>;
  return (
    <ul className="offer-asset-list">
      {items.map((s, i) => (
        <li key={i}>{s}</li>
      ))}
    </ul>
  );
}

/**
 * Decoded breakdown of a signCoinSpends / sendTransaction bundle.
 *
 * Calls the WASM `analyze_coin_spends` endpoint (via the popup-rpc
 * `analyze-coin-spends` envelope, which also derives our window of
 * owner puzzle hashes) and renders:
 *   • Each output address with amount + asset, flagged "yours" / "external"
 *   • Total XCH leaving the wallet vs returning as change
 *   • Total CAT amounts leaving per asset_id
 *   • Network fee
 *   • A loud warning when any spend was classified "unknown" (NFT/DID
 *     etc.) because the human-readable summary above is incomplete
 *     for those.
 *
 * If the analysis call fails entirely, falls back to the raw count +
 * a clear "could not decode" notice so the user is never silently
 * shown stale data.
 */
/**
 * A bundle needs an explicit acknowledgement before Approve unlocks when it
 * carries effects the readable summary can't fully account for: a spend
 * through an unrecognised puzzle, value leaving via an unknown layer, or a
 * replayable AGG_SIG_UNSAFE (a signature a dApp could reuse elsewhere).
 */
function bundleRequiresAck(a: CoinSpendAnalysis): boolean {
  const s = a.summary;
  return (
    s.unknown_spend_count > 0 ||
    (s.agg_sig_unsafe_count ?? 0) > 0 ||
    BigInt(s.total_unknown_out_mojos ?? "0") > 0n
  );
}

function CoinSpendBreakdown({
  coinSpends,
  catDisplay,
  onAnalysisReady,
  onRiskAssessed,
}: {
  coinSpends: Array<{
    coin: { parent_coin_info: string; puzzle_hash: string; amount: string | number };
    puzzle_reveal: string;
    solution: string;
  }>;
  catDisplay?: (assetId: string | null | undefined) => CatDisplay;
  onAnalysisReady?: (ready: boolean) => void;
  onRiskAssessed?: (requiresAck: boolean) => void;
}) {
  const [analysis, setAnalysis] = useState<CoinSpendAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The `coinSpends` prop is a freshly-allocated array on every parent
  // render. Using it as a useEffect dep re-fires the analysis on every
  // tick, which never finishes (each completion sets state, which
  // triggers another render, which restarts the fetch). Serialise once
  // so the dep is stable across renders of the same bundle.
  const cacheKey = JSON.stringify(coinSpends);

  useEffect(() => {
    let cancelled = false;
    setAnalysis(null);
    setError(null);
    onAnalysisReady?.(false);
    onRiskAssessed?.(false);
    if (coinSpends.length === 0) {
      onAnalysisReady?.(true);
      return;
    }
    void (async () => {
      try {
        const r = await analyzeCoinSpends(coinSpends);
        if (!cancelled) {
          setAnalysis(r);
          onRiskAssessed?.(bundleRequiresAck(r));
          onAnalysisReady?.(true);
        }
      } catch (err) {
        if (!cancelled) {
          setError((err as Error).message);
          // A bundle we couldn't decode at all is maximally opaque — force
          // the acknowledgement so it can't be blind-approved. The raw
          // params block below still shows exactly what would be signed.
          onRiskAssessed?.(true);
          onAnalysisReady?.(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: cacheKey is the stable derived dep; onAnalysisReady/onRiskAssessed are stable from parent.
  }, [cacheKey]);

  if (coinSpends.length === 0) {
    return <p className="muted small">No coin spends in this bundle.</p>;
  }
  if (error) {
    return (
      <div className="result">
        <p className="error small">
          ⚠ Could not decode this bundle: {error}.
        </p>
        <p className="muted small">
          The raw params below are exactly what the wallet would sign.
          Only approve if you trust the dApp completely.
        </p>
      </div>
    );
  }
  if (!analysis) {
    return (
      <div className="result" data-testid="breakdown-loading">
        <p className="muted small">
          ⏳ Decoding {coinSpends.length} spend
          {coinSpends.length === 1 ? "" : "s"}…
        </p>
        <p className="muted small">
          The <strong>Approve</strong> button stays disabled until the
          decoded summary shows up.
        </p>
      </div>
    );
  }

  const { summary } = analysis;
  const fee = BigInt(summary.total_fee_mojos);

  // Group outputs by ours-vs-external for the two-column offer-summary
  // layout. Each row shows a human-readable asset + amount.
  type RowKind = "xch" | "cat" | "unknown";
  interface Row {
    label: string;
    detail: string;
    raw: string;
    kind: RowKind;
  }
  const ours: Row[] = [];
  const external: Row[] = [];
  for (const s of analysis.spends) {
    for (const o of s.outputs) {
      const amt = BigInt(o.amount);
      if (amt <= 0n) continue;
      const cd = s.kind === "cat" && s.asset_id ? catDisplay?.(s.asset_id) : undefined;
      const label =
        s.kind === "cat" && s.asset_id
          ? `${mojosToCatUnits(o.amount, cd?.decimals ?? 3)} ${cd?.symbol ?? "CAT"} ${shortHash(s.asset_id)}`
          : s.kind === "xch"
            ? `${mojosToXch(o.amount)} XCH`
            : `${o.amount} (unknown layer)`;
      const detail = `${o.puzzle_hash.slice(0, 10)}…${o.puzzle_hash.slice(-6)}`;
      const row: Row = { label, detail, raw: o.puzzle_hash, kind: s.kind };
      (o.is_ours ? ours : external).push(row);
    }
  }

  return (
    <div className="offer-summary coin-spend-breakdown" data-testid="breakdown-ready">
      <div className="offer-side offer-pay">
        <span className="muted small">Going OUT (external)</span>
        {external.length === 0 ? (
          <p className="muted small">nothing leaves the wallet</p>
        ) : (
          <ul className="offer-asset-list">
            {external.map((r, i) => (
              <li key={i}>
                <div>{r.label}</div>
                <code className="muted small" title={r.raw}>→ {r.detail}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="offer-arrow" aria-hidden>↕</div>

      <div className="offer-side offer-receive">
        <span className="muted small">Returning to your wallet</span>
        {ours.length === 0 ? (
          <p className="muted small">nothing comes back as change</p>
        ) : (
          <ul className="offer-asset-list">
            {ours.map((r, i) => (
              <li key={i}>
                <div>{r.label}</div>
                <code className="muted small" title={r.raw}>← yours</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      {fee > 0n && (
        <p className="muted small">
          Network fee: {fmtXch(fee.toString())}
        </p>
      )}

      {summary.unknown_spend_count > 0 && (
        <p className="error small" data-testid="unknown-spend-warning">
          ⚠ {summary.unknown_spend_count} spend
          {summary.unknown_spend_count === 1 ? "" : "s"} use a puzzle Loroco
          can't decode (likely NFT/DID or a custom contract). The summary
          above only covers the parts we can read — review raw params
          before approving.
        </p>
      )}

      {BigInt(summary.total_unknown_out_mojos ?? "0") > 0n && (
        <p className="error small" data-testid="unknown-value-warning">
          ⚠ {summary.total_unknown_out_mojos} mojos leave through a puzzle
          Loroco can't classify. This value is NOT included in the totals
          above — treat the real cost as higher.
        </p>
      )}

      {(summary.agg_sig_unsafe_count ?? 0) > 0 && (
        <p className="error small" data-testid="agg-sig-unsafe-warning">
          ⚠ This bundle asks for {summary.agg_sig_unsafe_count} unsafe
          signature{summary.agg_sig_unsafe_count === 1 ? "" : "s"}{" "}
          (AGG_SIG_UNSAFE) — not bound to this coin, so a malicious site could
          reuse {summary.agg_sig_unsafe_count === 1 ? "it" : "them"} elsewhere.
          Only approve if you fully trust this site.
        </p>
      )}

      {(external.length > 0 || ours.length > 0) && (
        <details className="breakdown-details">
          <summary className="muted small">Show full recipient list</summary>
          <ul className="breakdown-recipients">
            {[...external.map((r) => ({ ...r, side: "external" as const })),
              ...ours.map((r) => ({ ...r, side: "ours" as const }))].map(
              (r, i) => (
                <li key={i}>
                  <code className="ph">{r.raw}</code>
                  <span className="muted small">
                    {r.label} · {r.side}
                  </span>
                </li>
              ),
            )}
          </ul>
        </details>
      )}
    </div>
  );
}

function ApprovalSummary({
  request,
  fingerprint,
  onAnalysisReady,
  onRiskAssessed,
}: {
  request: PendingApproval;
  fingerprint?: number | null;
  onAnalysisReady?: (ready: boolean) => void;
  onRiskAssessed?: (requiresAck: boolean) => void;
}) {
  const params = request.params as Record<string, unknown> | null;
  // Token metadata for the active wallet so CAT amounts render with the same
  // precision + symbol the user sees on Home/Activity (not a generic 3-decimal
  // "CAT"). Hook runs unconditionally before the switch.
  const catMeta = useApprovalCatMeta(fingerprint ?? null);
  const catDisplay = (assetId: string | null | undefined) => resolveCatDisplay(assetId, catMeta);

  switch (request.method) {
    case "connect":
    case "requestAccounts":
      return (
        <div className="permission-summary">
          <p className="muted">If you approve, this site will be allowed to:</p>
          <ul className="permission-list">
            <li>
              <span className="permission-icon ok" aria-hidden>✓</span>
              <span>See your XCH addresses + balances</span>
            </li>
            <li>
              <span className="permission-icon ok" aria-hidden>✓</span>
              <span>See your CATs, NFTs and ongoing offers</span>
            </li>
            <li>
              <span className="permission-icon warn" aria-hidden>!</span>
              <span>
                Request your approval each time it wants to{" "}
                <strong>sign</strong> or <strong>send</strong> a transaction
                (you'll see another popup like this)
              </span>
            </li>
            <li>
              <span className="permission-icon" aria-hidden>·</span>
              <span>
                Stay connected for up to <strong>7 days of inactivity</strong>,
                then auto-disconnect. Remove it sooner from{" "}
                <strong>Settings → Connected sites</strong>.
              </span>
            </li>
          </ul>
          <p className="muted small">
            Loroco never auto-connects new sites — approval is always explicit.
          </p>
        </div>
      );

    case "signMessage": {
      const message = params?.message;
      return (
        <div className="result">
          <div>
            <span className="muted">message (hex)</span>
            <code>{String(message ?? "")}</code>
          </div>
        </div>
      );
    }

    case "transfer": {
      // WC2 `chia_send` uses `address`; Goby `transfer` uses `to`. The
      // handler accepts either, so the popup must too — otherwise a
      // malicious dApp sending only `{address: "evil"}` leaves the "to"
      // field blank and the user has no idea where funds are headed.
      const to = params?.to ?? params?.address;
      const amount = params?.amount;
      const assetId = params?.assetId;
      const fee = params?.fee;
      const isXch = assetId == null || assetId === "";
      const cd = catDisplay(isXch ? null : String(assetId));
      return (
        <div className="result">
          <div>
            <span className="muted">to</span>
            <code title={String(to ?? "")}>{String(to ?? "")}</code>
          </div>
          <div>
            <span className="muted">amount</span>
            <code>{amount != null ? (isXch ? fmtXch(String(amount)) : fmtCat(String(amount), cd.symbol, cd.decimals)) : ""}</code>
          </div>
          <div>
            <span className="muted">asset id</span>
            <code>{isXch ? "(XCH)" : `${cd.symbol ? cd.symbol + " · " : ""}${String(assetId)}`}</code>
          </div>
          {fee != null && (
            <div>
              <span className="muted">network fee</span>
              <code>{fmtXch(String(fee))}</code>
            </div>
          )}
        </div>
      );
    }

    case "takeOffer": {
      const offer = typeof params?.offer === "string" ? (params.offer as string) : "";
      // Fee row omitted — takeOffer renders the editable fee-override control
      // below this summary (see ApprovalScreen), so it would duplicate it.
      return offer ? <TakeOfferSummary offer={offer} catDisplay={catDisplay} /> : null;
    }

    case "walletWatchAsset": {
      const opts = (params?.options as { assetId?: string; symbol?: string; logo?: string } | undefined) ?? {};
      return (
        <div className="result">
          <p className="muted small">
            This site wants the wallet to track a new asset so you can see its
            balance + send it from the Send tab.
          </p>
          <div>
            <span className="muted">symbol</span>
            <code>{String(opts.symbol ?? "(unknown)")}</code>
          </div>
          <div>
            <span className="muted">asset id</span>
            <code>{String(opts.assetId ?? "")}</code>
          </div>
          {opts.logo && (
            <div>
              <span className="muted">logo</span>
              <code>{String(opts.logo)}</code>
            </div>
          )}
        </div>
      );
    }

    case "walletSwitchChain": {
      const chainId = params?.chainId as string | undefined;
      return (
        <div className="result">
          <p className="muted small">
            This site wants to switch the wallet's active network.
          </p>
          <div>
            <span className="muted">requested chain</span>
            <code>{String(chainId ?? "")}</code>
          </div>
          <p className="muted small">
            Loroco only supports <strong>mainnet</strong> today — any other
            value will be rejected even if you approve.
          </p>
        </div>
      );
    }

    case "sendTransaction": {
      const sb = params?.spendBundle as
        | {
            coin_spends?: Array<{
              coin: { parent_coin_info: string; puzzle_hash: string; amount: string | number };
              puzzle_reveal: string;
              solution: string;
            }>;
          }
        | undefined;
      const cs = sb?.coin_spends ?? [];
      return (
        <div className="result">
          <p className="muted small">
            This site asks the wallet to broadcast a pre-built spend bundle.
            You will sign nothing — but you will publish it.
          </p>
          <CoinSpendBreakdown
            coinSpends={cs}
            catDisplay={catDisplay}
            onAnalysisReady={onAnalysisReady}
            onRiskAssessed={onRiskAssessed}
          />
        </div>
      );
    }

    case "signCoinSpends": {
      const cs = (params?.coinSpends as Array<{
        coin: { parent_coin_info: string; puzzle_hash: string; amount: string | number };
        puzzle_reveal: string;
        solution: string;
      }> | undefined) ?? [];
      return (
        <div className="result">
          <p className="muted small">
            This site asks the wallet to sign {cs.length} coin spend
            {cs.length === 1 ? "" : "s"}. Signing makes them broadcastable —
            review what's moving below.
          </p>
          <CoinSpendBreakdown
            coinSpends={cs}
            catDisplay={catDisplay}
            onAnalysisReady={onAnalysisReady}
            onRiskAssessed={onRiskAssessed}
          />
        </div>
      );
    }

    case "createOffer": {
      const offerAssets = (params?.offerAssets as Array<{ assetId: string; amount: string }> | undefined) ?? [];
      const requestAssets = (params?.requestAssets as Array<{ assetId: string; amount: string }> | undefined) ?? [];
      const fmtOfferAsset = (a: { assetId: string; amount: string }) => {
        if (a.assetId === "") return fmtXch(a.amount);
        const cd = catDisplay(a.assetId);
        return `${mojosToCatUnits(a.amount, cd.decimals)} ${cd.symbol ?? shortHash(a.assetId)}`;
      };
      return (
        // The fee row is intentionally omitted here — createOffer renders the
        // editable fee-override control just below this summary, so showing it
        // twice (once raw, once editable) was redundant and confusing.
        <div className="offer-summary">
          <div className="offer-side offer-pay">
            <span className="muted small">You will offer</span>
            <ul className="offer-asset-list">
              {offerAssets.length === 0 ? (
                <li className="muted small">nothing</li>
              ) : (
                offerAssets.map((a, i) => <li key={i}>{fmtOfferAsset(a)}</li>)
              )}
            </ul>
          </div>
          <div className="offer-arrow" aria-hidden>↕</div>
          <div className="offer-side offer-receive">
            <span className="muted small">You request</span>
            <ul className="offer-asset-list">
              {requestAssets.length === 0 ? (
                <li className="muted small">nothing</li>
              ) : (
                requestAssets.map((a, i) => <li key={i}>{fmtOfferAsset(a)}</li>)
              )}
            </ul>
          </div>
        </div>
      );
    }

    case "signMessageByAddress": {
      const message = params?.message;
      const address = params?.address;
      return (
        <div className="result">
          <p className="muted small">
            This site is asking the wallet to sign a message using the key for a
            specific address you own. Signed messages can prove ownership but
            cannot move funds.
          </p>
          <div>
            <span className="muted">address</span>
            <code>{String(address ?? "")}</code>
          </div>
          <div>
            <span className="muted">message (hex)</span>
            <code>{String(message ?? "")}</code>
          </div>
        </div>
      );
    }

    case "cancelOffer": {
      const id = params?.id;
      const secure = params?.secure !== false;
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            This site is asking the wallet to {secure ? "broadcast a cancellation spend for" : "drop local tracking of"}{" "}
            an offer. {secure ? "A cancellation spend prevents anyone from accepting the offer afterwards." : "The offer can still be accepted on-chain if someone has the offer string."}
          </p>
          <div>
            <span className="muted">offer id</span>
            <code>{String(id ?? "")}</code>
          </div>
          {fee != null && BigInt(String(fee)) > 0n && (
            <div>
              <span className="muted">network fee</span>
              <code>{fmtXch(String(fee))}</code>
            </div>
          )}
        </div>
      );
    }

    case "bulkSendXch": {
      const outputs = (params?.outputs as Array<{ address: string; amount: string | number }> | undefined) ?? [];
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Send XCH to {outputs.length} recipient{outputs.length === 1 ? "" : "s"} in one transaction.
          </p>
          <OutputsList outputs={outputs} kind="xch" />
          <SumRow outputs={outputs} kind="xch" />
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "bulkSendCat": {
      const assetId = params?.assetId;
      const outputs = (params?.outputs as Array<{ address: string; amount: string | number }> | undefined) ?? [];
      const fee = params?.fee;
      const cd = catDisplay(String(assetId ?? ""));
      return (
        <div className="result">
          <p className="muted small">
            Send a token (CAT) to {outputs.length} recipient{outputs.length === 1 ? "" : "s"}.
          </p>
          <div><span className="muted">asset id</span><code>{`${cd.symbol ? cd.symbol + " · " : ""}${String(assetId ?? "")}`}</code></div>
          <OutputsList outputs={outputs} kind="cat" assetSymbol={cd.symbol} decimals={cd.decimals} />
          <SumRow outputs={outputs} kind="cat" assetSymbol={cd.symbol} decimals={cd.decimals} />
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "multiSend": {
      const xchOutputs = (params?.xchOutputs as Array<{ address: string; amount: string | number }> | undefined) ?? [];
      const catBlock = params?.catOutputs as { assetId?: string; outputs?: Array<{ address: string; amount: string | number }> } | undefined;
      const catOutputs = catBlock?.outputs ?? [];
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Send to multiple recipients in ONE atomic transaction (all-or-nothing).
          </p>
          {xchOutputs.length > 0 && (
            <>
              <span className="muted small">XCH outputs</span>
              <OutputsList outputs={xchOutputs} kind="xch" />
            </>
          )}
          {catOutputs.length > 0 && (() => {
            const cd = catDisplay(String(catBlock?.assetId ?? ""));
            return (
              <>
                <div><span className="muted">CAT asset id</span><code>{`${cd.symbol ? cd.symbol + " · " : ""}${String(catBlock?.assetId ?? "")}`}</code></div>
                <OutputsList outputs={catOutputs} kind="cat" assetSymbol={cd.symbol} decimals={cd.decimals} />
              </>
            );
          })()}
          {xchOutputs.length === 0 && catOutputs.length === 0 && (
            <p className="muted small">No outputs specified.</p>
          )}
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "combine": {
      const maxInputs = params?.maxInputs ?? 10;
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Consolidate up to <strong>{String(maxInputs)}</strong> of your own XCH coins
            into a single coin. The result is sent back to your own wallet — no
            funds leave it.
          </p>
          <div><span className="muted">max inputs</span><code>{String(maxInputs)}</code></div>
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "split": {
      const parts = params?.parts;
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Split your largest XCH coin into <strong>{String(parts ?? "?")}</strong> equal
            coins, sent back to your own wallet — no funds leave it.
          </p>
          <div><span className="muted">parts</span><code>{String(parts ?? "")}</code></div>
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "issueCat": {
      const recipient = params?.recipientAddress;
      const amount = params?.amount;
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Mint a <strong>brand-new token (CAT)</strong>. This creates a new,
            unrepeatable token type and gives the whole initial supply to the
            address below.
          </p>
          <div><span className="muted">supply</span><code>{amount != null ? fmtCat(String(amount)) : ""}</code></div>
          <div><span className="muted">recipient</span><code title={String(recipient ?? "")}>{String(recipient ?? "")}</code></div>
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "createDid": {
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Create a new <strong>DID</strong> (a decentralized-identity profile)
            owned by this wallet. It uses 1 mojo of your XCH plus any fee, and can
            later own NFTs or sign as you.
          </p>
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "addNftUri": {
      const launcherId = params?.launcherId;
      const coinId = params?.coinId;
      const uriKind = params?.uriKind;
      const uri = params?.uri;
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Append a URI to one of your NFT's metadata lists. The NFT is re-spent
            back to you — only its metadata changes.
          </p>
          <div><span className="muted">NFT</span><code>{String(launcherId ?? coinId ?? "")}</code></div>
          <div><span className="muted">list</span><code>{String(uriKind ?? "")}</code></div>
          <div><span className="muted">uri</span><code title={String(uri ?? "")}>{String(uri ?? "")}</code></div>
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "transferDid": {
      const recipient = params?.recipientAddress;
      const didCoinId = params?.didCoinId;
      const idx = params?.didDerivationIndex;
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            <strong>Transfer ownership of a DID</strong> to another address. After
            this you will no longer control this DID.
          </p>
          <div><span className="muted">recipient</span><code title={String(recipient ?? "")}>{String(recipient ?? "")}</code></div>
          <div><span className="muted">DID coin id</span><code>{String(didCoinId ?? "")}</code></div>
          <div><span className="muted">derivation index</span><code>{String(idx ?? "")}</code></div>
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "normalizeDids": {
      const coinIds = (params?.didCoinIds as string[] | undefined) ?? [];
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Reset {coinIds.length} DID{coinIds.length === 1 ? "" : "s"} to the
            simple profile (empty recovery list, 1 verification required). Owner
            and metadata are unchanged.
          </p>
          <ul className="detail-list">
            {coinIds.map((c, i) => (
              <li key={i}><code>{shortHash(String(c))}</code></li>
            ))}
          </ul>
          {fee != null && (
            <div><span className="muted">network fee (first tx only)</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    case "bulkMintNfts": {
      const did = params?.did;
      const nfts = (params?.nfts as Array<{ dataUris?: string[]; editionNumber?: number; editionTotal?: number }> | undefined) ?? [];
      const fee = params?.fee;
      return (
        <div className="result">
          <p className="muted small">
            Mint <strong>{nfts.length}</strong> NFT{nfts.length === 1 ? "" : "s"} under the DID below.
          </p>
          <div><span className="muted">DID</span><code>{String(did ?? "")}</code></div>
          <ul className="detail-list">
            {nfts.map((n, i) => (
              <li key={i}>
                <code>
                  #{n.editionNumber ?? i + 1}
                  {n.editionTotal ? `/${n.editionTotal}` : ""}{" "}
                  {n.dataUris?.[0] ? n.dataUris[0] : "(no data uri)"}
                </code>
              </li>
            ))}
          </ul>
          {fee != null && (
            <div><span className="muted">network fee</span><code>{fmtXch(String(fee))}</code></div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
}

// Shared helpers for the multi-output approval summaries above.
// `kind` decides how the raw-mojos amounts are humanised: XCH (12 decimals)
// or CAT (3 decimals). `assetSymbol` overrides the "CAT" label when known.
function fmtOutputAmount(
  amount: string | number,
  kind: "xch" | "cat",
  assetSymbol?: string,
  decimals = 3,
): string {
  return kind === "xch" ? fmtXch(amount) : fmtCat(amount, assetSymbol, decimals);
}

function OutputsList({
  outputs,
  kind,
  assetSymbol,
  decimals = 3,
}: {
  outputs: Array<{ address: string; amount: string | number }>;
  kind: "xch" | "cat";
  assetSymbol?: string;
  decimals?: number;
}) {
  if (outputs.length === 0) return <p className="muted small">No outputs.</p>;
  return (
    <ul className="detail-list">
      {outputs.map((o, i) => (
        <li key={i}>
          <code>{fmtOutputAmount(o.amount, kind, assetSymbol, decimals)}</code> →{" "}
          <code title={String(o.address)}>{shortHash(String(o.address))}</code>
        </li>
      ))}
    </ul>
  );
}

function SumRow({
  outputs,
  kind,
  assetSymbol,
  decimals = 3,
}: {
  outputs: Array<{ address: string; amount: string | number }>;
  kind: "xch" | "cat";
  assetSymbol?: string;
  decimals?: number;
}) {
  let total = 0n;
  try {
    for (const o of outputs) total += BigInt(String(o.amount ?? "0"));
  } catch {
    return null;
  }
  return (
    <div>
      <span className="muted">total</span>
      <code>{fmtOutputAmount(total.toString(), kind, assetSymbol, decimals)}</code>
    </div>
  );
}

function LoadingScreen() {
  return (
    <section className="screen">
      <p className="muted">Loading…</p>
    </section>
  );
}

type OnboardingMode = "choose" | "create" | "import" | "import-key";

function OnboardingScreen({
  onDone,
  onCancel,
}: {
  onDone: (w: StoredWallet) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<OnboardingMode>("choose");
  const [mnemonic, setMnemonic] = useState<string>("");
  const [secretKey, setSecretKey] = useState<string>("");
  const [wordCount, setWordCount] = useState<12 | 24>(24);
  const [password, setPassword] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async (count: 12 | 24) => {
    setError(null);
    try {
      const res = await callEngine<{ mnemonic: string }>("generate_mnemonic", { words: count });
      setMnemonic(res.mnemonic);
      setWordCount(count);
      setMode("create");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const finishMnemonic = async () => {
    if (!password.trim()) {
      setError("Set a password");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const importRes = await callEngine<{
        fingerprint: number;
        keychain_blob: string;
        master_public_key: string;
      }>("import_mnemonic", {
        mnemonic: mnemonic.trim(),
        password,
        testnet: false,
      });
      await persistAndActivate(importRes, password, onDone);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finishSecretKey = async () => {
    if (!password.trim()) {
      setError("Set a password");
      return;
    }
    if (!secretKey.trim()) {
      setError("Paste a 64-char hex secret key");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const importRes = await callEngine<{
        fingerprint: number;
        keychain_blob: string;
        master_public_key: string;
      }>("import_secret_key", {
        secret_key: secretKey.trim(),
        password,
        testnet: false,
      });
      await persistAndActivate(importRes, password, onDone);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (mode === "choose") {
    return (
      <section className="screen">
        <span className="brand-lockup brand-lockup--stacked">
          <img src="/icon/256.png" alt="" className="brand-mark" />
          <span className="brand-word">loroco</span>
        </span>
        <h1>Welcome</h1>
        <p className="muted">A Chia wallet for your browser. Choose how to get started.</p>
        {error && <p className="error">{error}</p>}
        <button onClick={() => void generate(24)}>Create new wallet (24 words)</button>
        <button className="secondary" onClick={() => void generate(12)}>
          Create new wallet (12 words)
        </button>
        <button className="secondary" onClick={() => setMode("import")}>
          Import mnemonic (12 or 24 words)
        </button>
        <button className="secondary" onClick={() => setMode("import-key")}>
          Import private key (hex)
        </button>
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </section>
    );
  }

  if (mode === "import-key") {
    return (
      <section className="screen">
        <h1>Import private key</h1>
        <p className="muted">Paste the 32-byte BLS master secret key as hex (64 characters).</p>
        <textarea
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="0x<64 hex chars>"
        />
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Used to encrypt the key on this device"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button className="secondary" onClick={() => setMode("choose")} disabled={busy}>
            Back
          </button>
          <button
            onClick={() => void finishSecretKey()}
            disabled={busy || !secretKey.trim() || !password.trim()}
          >
            {busy ? "Saving…" : "Continue"}
          </button>
        </div>
      </section>
    );
  }

  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  const isCreating = mode === "create";
  const showSeedGrid =
    isCreating && (words.length === wordCount || words.length === 12 || words.length === 24);

  return (
    <section className="screen">
      <h1>{isCreating ? "Save your seed phrase" : "Import mnemonic"}</h1>
      {isCreating && (
        <p className="muted">
          Write these {wordCount} words down somewhere safe. They're the only way to recover your
          wallet.
        </p>
      )}
      {showSeedGrid ? (
        <div className="seed-grid">
          {words.map((w, i) => (
            <span className="seed-pill" key={i}>
              <span className="seed-pill-index">{i + 1}</span>
              <span className="seed-pill-word">{w}</span>
            </span>
          ))}
        </div>
      ) : (
        <textarea
          value={mnemonic}
          onChange={(e) => setMnemonic(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder="12 or 24 words, space-separated"
        />
      )}
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Used to encrypt the seed on this device"
        />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button className="secondary" onClick={() => setMode("choose")} disabled={busy}>
          Back
        </button>
        <button
          onClick={() => void finishMnemonic()}
          disabled={busy || !mnemonic.trim() || !password.trim()}
        >
          {busy ? "Saving…" : "Continue"}
        </button>
      </div>
    </section>
  );
}

async function persistAndActivate(
  importRes: { fingerprint: number; keychain_blob: string; master_public_key: string },
  password: string,
  onDone: (w: StoredWallet) => void | Promise<void>,
) {
  const wallet: StoredWallet = {
    fingerprint: importRes.fingerprint,
    keychainBlob: importRes.keychain_blob,
    masterPublicKey: importRes.master_public_key,
    label: `Wallet ${importRes.fingerprint}`,
    createdAt: Date.now(),
  };
  await saveWallet(wallet);
  await onDone(wallet);
  await callEngine("unlock_keychain", {
    keychain_blob: importRes.keychain_blob,
    fingerprint: importRes.fingerprint,
    password,
  });
  // Derive hardened receive PHs once and stash them so background sync can
  // include them without needing the wallet unlocked on every SW revive.
  void cacheHardenedPhs(wallet.fingerprint).catch((err) => {
    console.warn("[Loroco] cacheHardenedPhs failed (import):", err);
  });
}

function HeaderWalletChip({
  wallet,
  wallets,
  onSwitchWallet,
  onAddWallet,
}: {
  wallet: StoredWallet;
  wallets: StoredWallet[];
  onSwitchWallet: (fp: number) => void | Promise<void>;
  onAddWallet: () => void;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".wallet-chip")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fp: number) => {
    setOpen(false);
    if (fp !== wallet.fingerprint) void onSwitchWallet(fp);
  };

  return (
    <div className={"wallet-chip" + (open ? " open" : "")}>
      <button
        type="button"
        className="wallet-chip-btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={
          wallet.label === `Wallet ${wallet.fingerprint}`
            ? `Wallet ${wallet.fingerprint}`
            : `${wallet.label} · ${wallet.fingerprint}`
        }
      >
        <span className="wallet-chip-fp">{wallet.fingerprint}</span>
        <span className="wallet-chip-chev" aria-hidden>▾</span>
      </button>
      {open && (
        <div className="wallet-chip-popover" role="menu">
          <ul className="wallet-chip-list">
            {wallets.map((w) => {
              const isActive = w.fingerprint === wallet.fingerprint;
              return (
                <li key={w.fingerprint}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={"wallet-chip-item" + (isActive ? " active" : "")}
                    onClick={() => pick(w.fingerprint)}
                  >
                    <span className="wallet-chip-item-dot" aria-hidden>
                      {isActive ? "●" : "○"}
                    </span>
                    <span className="wallet-chip-item-label">
                      {w.label === `Wallet ${w.fingerprint}` ? `Wallet` : w.label}
                    </span>
                    <span className="wallet-chip-item-fp">{w.fingerprint}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            className="wallet-chip-add"
            onClick={() => {
              setOpen(false);
              onAddWallet();
            }}
          >
            + Add another wallet
          </button>
        </div>
      )}
    </div>
  );
}

function LockScreen({
  wallet,
  wallets,
  onUnlocked,
  onSwitchWallet,
}: {
  wallet: StoredWallet;
  wallets: StoredWallet[];
  onUnlocked: (w: StoredWallet) => void | Promise<void>;
  onSwitchWallet: (fp: number) => void | Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [confirmingForget, setConfirmingForget] = useState(false);

  const forget = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeWallet(wallet.fingerprint);
      const remaining = wallets.filter((w) => w.fingerprint !== wallet.fingerprint);
      if (remaining.length > 0) {
        await onSwitchWallet(remaining[0]!.fingerprint);
      } else {
        await chrome.storage.session.remove("activeFingerprint");
        await chrome.runtime.sendMessage({
          from: "popup",
          kind: "set-active-wallet",
          walletId: null,
        });
        window.location.reload();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setConfirmingForget(false);
    }
  };

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await callEngine<{
        fingerprint: number;
        mnemonic: string;
        master_public_key: string;
      }>("unlock_keychain", {
        keychain_blob: wallet.keychainBlob,
        fingerprint: wallet.fingerprint,
        password,
      });
      const w = !wallet.masterPublicKey && res.master_public_key
        ? { ...wallet, masterPublicKey: res.master_public_key }
        : wallet;
      if (w !== wallet) await saveWallet(w);
      void cacheHardenedPhs(w.fingerprint).catch((err) => {
        console.warn("[Loroco] cacheHardenedPhs failed:", err);
      });
      await onUnlocked(w);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const displayLabel =
    wallet.label === `Wallet ${wallet.fingerprint}`
      ? `Wallet ${wallet.fingerprint}`
      : wallet.label;

  return (
    <section className="screen lock-screen">
      <div className="lock-hero">
        <span className="brand-lockup brand-lockup--stacked">
          <img src="/icon/256.png" alt="" className="brand-mark" />
          <span className="brand-word">loroco</span>
        </span>
        <h1 className="lock-title">Welcome back</h1>
        <p className="lock-sub">Enter your password to unlock</p>
      </div>

      <button
        type="button"
        className="lock-wallet-chip"
        onClick={() => wallets.length > 1 && setShowSwitcher(true)}
        disabled={wallets.length <= 1}
        aria-label="Switch wallet"
      >
        <span className="lock-wallet-avatar" aria-hidden>
          {displayLabel.slice(0, 1).toUpperCase()}
        </span>
        <span className="lock-wallet-meta">
          <span className="lock-wallet-label">{displayLabel}</span>
          <span className="lock-wallet-fp">#{wallet.fingerprint}</span>
        </span>
        {wallets.length > 1 && (
          <span className="lock-wallet-switch" aria-hidden>
            ⇅
          </span>
        )}
      </button>

      <form
        className="lock-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && password) void unlock();
        }}
      >
        <div className={"lock-input" + (error ? " has-error" : "")}>
          <span className="lock-input-icon" aria-hidden>🔒</span>
          <input
            type={showPwd ? "text" : "password"}
            autoFocus
            value={password}
            placeholder="Password"
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
          />
          <button
            type="button"
            className="lock-input-eye"
            onClick={() => setShowPwd((v) => !v)}
            aria-label={showPwd ? "Hide password" : "Show password"}
            tabIndex={-1}
          >
            {showPwd ? "🙈" : "👁"}
          </button>
        </div>
        {error && <p className="error lock-error">{error}</p>}
        <button
          type="submit"
          className="lock-submit"
          disabled={busy || !password}
        >
          {busy ? "Unlocking…" : "Unlock"}
        </button>
      </form>

      <button
        type="button"
        className="lock-forgot"
        onClick={() => setConfirmingForget(true)}
        disabled={busy}
      >
        Forgot password?
      </button>

      {showSwitcher && (
        <Modal title="Switch wallet" onClose={() => setShowSwitcher(false)}>
          <ul className="settings-section-list">
            {wallets.map((w) => (
              <li key={w.fingerprint}>
                <button
                  type="button"
                  className={
                    "settings-section-row" +
                    (w.fingerprint === wallet.fingerprint ? " active" : "")
                  }
                  onClick={() => {
                    setShowSwitcher(false);
                    if (w.fingerprint !== wallet.fingerprint) {
                      void onSwitchWallet(w.fingerprint);
                    }
                  }}
                >
                  <span className="settings-section-icon" aria-hidden>
                    {(w.label === `Wallet ${w.fingerprint}` ? "W" : w.label.slice(0, 1)).toUpperCase()}
                  </span>
                  <span className="settings-section-meta">
                    <span className="settings-section-title">
                      {w.label === `Wallet ${w.fingerprint}`
                        ? `Wallet ${w.fingerprint}`
                        : w.label}
                    </span>
                    <span className="settings-section-sub">#{w.fingerprint}</span>
                  </span>
                  <span className="settings-section-chev" aria-hidden>
                    {w.fingerprint === wallet.fingerprint ? "●" : "›"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}

      {confirmingForget && (
        <Modal title="Remove this wallet?" onClose={() => setConfirmingForget(false)}>
          <p className="form-note">
            This deletes the encrypted seed for{" "}
            <strong>{displayLabel}</strong> from this browser. Make sure you
            have your <strong>recovery phrase</strong> before continuing — it's
            the only way to restore the wallet.
          </p>
          <button
            type="button"
            className="danger"
            onClick={() => void forget()}
            disabled={busy}
          >
            {busy ? "Removing…" : "Yes, remove this wallet"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={() => setConfirmingForget(false)}
            disabled={busy}
          >
            Cancel
          </button>
        </Modal>
      )}
    </section>
  );
}

interface BalanceInfo {
  total_unspent_mojos: string;
  total_unspent_xch: string;
  unspent_coin_count: number;
  addresses: Array<{
    index: number;
    puzzle_hash: string;
    address: string;
    unspent_mojos: string;
    unspent_count: number;
  }>;
}

function HomeScreen({
  wallet,
  wallets,
  tab,
  setTab,
  onLock,
  onSwitchWallet,
  onAddWallet,
}: {
  wallet: StoredWallet;
  wallets: StoredWallet[];
  tab: TabName;
  setTab: (t: TabName) => void;
  onLock: () => void | Promise<void>;
  onSwitchWallet: (fp: number) => void | Promise<void>;
  onAddWallet: () => void;
}) {
  const [sync, setSync] = useState<SyncState | null>(null);
  const [coinTelemetry, setCoinTelemetry] = useState<CoinSyncTelemetry | null>(null);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [xchPrice, setXchPrice] = useState<number | null>(null);
  // Mojos straight from the local coin store. This is the source of truth
  // for total XCH balance because it includes coins received on hardened
  // addresses + coins matched by hint — both of which `get_address_balance`
  // misses (that endpoint scans only unhardened receive PHs via coinset).
  const [storeMojos, setStoreMojos] = useState<string | null>(null);
  const [storeCoinCount, setStoreCoinCount] = useState<number | null>(null);

  const refreshSync = async () => {
    try {
      const [s, t] = await Promise.all([getSyncState(), getCoinSyncTelemetry()]);
      setSync(s);
      setCoinTelemetry(t);
    } catch {
      // ignore — best-effort
    }
  };

  const refreshBalance = async () => {
    setBalanceLoading(true);
    try {
      // Source 1: the local coin store snapshot — fast, complete, includes
      // hint-matched coins. This drives the header balance display.
      try {
        const snap = await getCoinSnapshot(wallet.fingerprint);
        setStoreMojos(snap.unspent_mojos);
        setStoreCoinCount(snap.unspent_count);
      } catch {
        // ignore — fall back to get_address_balance below
      }
      // Source 2: per-address breakdown (still used by the Receive tab to
      // show unhardened addresses with their balances).
      const res = await callEngine<BalanceInfo>("get_address_balance", {
        fingerprint: wallet.fingerprint,
        start: 0,
        count: 50,
        testnet: false,
      });
      setBalance(res);
      setBalanceError(null);
    } catch (err) {
      setBalanceError((err as Error).message);
    } finally {
      setBalanceLoading(false);
    }
  };

  useEffect(() => {
    void refreshSync();
    void refreshBalance();
    void getXchPriceUsd().then(setXchPrice).catch(() => {});
    // Kick off a coin sync immediately on popup open so the user sees fresh
    // data without waiting for the next chrome.alarm tick (~30 s).
    void forceCoinSync().catch(() => {});
    const id = setInterval(() => {
      void refreshSync();
    }, 5_000);
    const balanceTimer = setInterval(() => {
      void refreshBalance();
    }, 30_000);
    const priceTimer = setInterval(() => {
      void getXchPriceUsd().then(setXchPrice).catch(() => {});
    }, 60_000);
    return () => {
      clearInterval(id);
      clearInterval(balanceTimer);
      clearInterval(priceTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.fingerprint]);

  // Show the compact balance row only on tabs that aren't already showing
  // it themselves (Settings/Status have their own scrollable surfaces).
  const showBalanceBar = tab !== "settings" && tab !== "status";

  return (
    <section className="screen has-bottom-nav">
      {showBalanceBar && (
        <div className="wallet-bar">
          <div className="wallet-bar-main">
            <h1 className="balance">
              {storeMojos != null
                ? `${mojosToXch(storeMojos)} XCH`
                : balance
                  ? `${balance.total_unspent_xch} XCH`
                  : balanceLoading
                    ? "…"
                    : "0.0000 XCH"}
              {xchPrice && storeMojos != null && (
                <span className="balance-usd">
                  ≈ ${formatUsd(
                    (Number(BigInt(storeMojos)) / 1_000_000_000_000) * xchPrice,
                  )}
                </span>
              )}
            </h1>
          </div>
          <SyncBadge sync={sync} telemetry={coinTelemetry} />
        </div>
      )}

      <div className="tab-content-wrap">
        {tab === "home" && (
          <HomeTab
            balance={balance}
            balanceError={balanceError}
            onRefresh={() => void refreshBalance()}
            wallet={wallet}
            xchPrice={xchPrice}
          />
        )}
        {tab === "send" && <SendTab wallet={wallet} balance={balance} />}
        {tab === "receive" && <ReceiveTab wallet={wallet} />}
        {tab === "nfts" && <NftsTab wallet={wallet} />}
        {tab === "activity" && <ActivityTab wallet={wallet} xchPrice={xchPrice} />}
        {tab === "dev" && <DevTab wallet={wallet} />}
        {tab === "settings" && (
          <SettingsTab
            wallet={wallet}
            wallets={wallets}
            onLock={onLock}
            onSwitchWallet={onSwitchWallet}
            onAddWallet={onAddWallet}
          />
        )}
        {tab === "status" && <StatusTab sync={sync} />}
      </div>

      <nav className="tabs tabs-bottom">
        <button
          className={tab === "home" ? "tab active" : "tab"}
          onClick={() => setTab("home")}
          title="Home"
          aria-label="Home"
        >
          <span className="tab-icon" aria-hidden>⌂</span>
          <span className="tab-label">Home</span>
        </button>
        <button
          className={tab === "send" ? "tab active" : "tab"}
          onClick={() => setTab("send")}
          title="Send"
          aria-label="Send"
        >
          <span className="tab-icon" aria-hidden>↑</span>
          <span className="tab-label">Send</span>
        </button>
        <button
          className={tab === "receive" ? "tab active" : "tab"}
          onClick={() => setTab("receive")}
          title="Receive"
          aria-label="Receive"
        >
          <span className="tab-icon" aria-hidden>↓</span>
          <span className="tab-label">Receive</span>
        </button>
        <button
          className={tab === "nfts" ? "tab active" : "tab"}
          onClick={() => setTab("nfts")}
          title="NFTs"
          aria-label="NFTs"
        >
          <span className="tab-icon" aria-hidden>▦</span>
          <span className="tab-label">NFTs</span>
        </button>
        <button
          className={tab === "activity" ? "tab active" : "tab"}
          onClick={() => setTab("activity")}
          title="Activity"
          aria-label="Activity"
        >
          <span className="tab-icon" aria-hidden>⟳</span>
          <span className="tab-label">Activity</span>
        </button>
      </nav>
    </section>
  );
}

type SettingsModal =
  | null
  | "recovery"
  | "connections"
  | "sidecar"
  | "compat"
  | "notifications"
  | "offer";

function SettingsTab({
  wallet,
  wallets,
  onLock,
  onSwitchWallet,
  onAddWallet,
}: {
  wallet: StoredWallet;
  wallets: StoredWallet[];
  onLock: () => void | Promise<void>;
  onSwitchWallet: (fp: number) => void | Promise<void>;
  onAddWallet: () => void;
}) {
  const [modal, setModal] = useState<SettingsModal>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [copiedFingerprint, setCopiedFingerprint] = useState(false);

  const copyFp = async () => {
    await navigator.clipboard.writeText(wallet.fingerprint.toString());
    setCopiedFingerprint(true);
    setTimeout(() => setCopiedFingerprint(false), 1500);
  };

  const resetWallet = async () => {
    await removeWallet(wallet.fingerprint);
    await callEngine("lock_keychain", { fingerprint: wallet.fingerprint });
    await onLock();
  };

  const closeModal = () => setModal(null);

  return (
    <div className="tab-body">
      <h3>Wallets</h3>
      <div className="wallet-list">
        {wallets.map((w) => (
          <button
            key={w.fingerprint}
            className={
              "wallet-row" + (w.fingerprint === wallet.fingerprint ? " active" : "")
            }
            onClick={() =>
              w.fingerprint !== wallet.fingerprint && void onSwitchWallet(w.fingerprint)
            }
            disabled={w.fingerprint === wallet.fingerprint}
          >
            <span className="wallet-row-dot" aria-hidden>
              {w.fingerprint === wallet.fingerprint ? "●" : "○"}
            </span>
            <span className="wallet-row-label">
              {w.label === `Wallet ${w.fingerprint}` ? ` ${w.fingerprint}` : w.label}
            </span>
            <span className="wallet-row-fp muted">{w.fingerprint}</span>
          </button>
        ))}
      </div>
      <button className="secondary" onClick={onAddWallet}>
        + Add another wallet
      </button>

      <h3>Active wallet</h3>
      <div className="result">
        <div>
          <span className="muted">label</span>
          <code>{wallet.label}</code>
        </div>
        <div onClick={() => void copyFp()} style={{ cursor: "pointer" }}>
          <span className="muted">fingerprint {copiedFingerprint && "· copied"}</span>
          <code>{wallet.fingerprint}</code>
        </div>
        <div>
          <span className="muted">created</span>
          <code>{new Date(wallet.createdAt).toLocaleString()}</code>
        </div>
      </div>

      <h3>Security &amp; access</h3>
      <ul className="settings-section-list">
        <SettingsSectionRow
          icon="🔐"
          title="Recovery phrase"
          sub="Reveal the 24-word seed for this wallet"
          onClick={() => setModal("recovery")}
        />
        <SettingsSectionRow
          icon="🔗"
          title="Connected sites"
          sub="dApps that can talk to this wallet"
          onClick={() => setModal("connections")}
        />
      </ul>

      <h3>Alerts</h3>
      <ul className="settings-section-list">
        <SettingsSectionRow
          icon="🔔"
          title="Notifications"
          sub="Alert on incoming, confirmed and external sends"
          onClick={() => setModal("notifications")}
        />
      </ul>

      <h3>Network</h3>
      <ul className="settings-section-list">
        <SettingsSectionRow
          icon="🛰"
          title="Local peer sync"
          sub="Use ozone-sidecar instead of coinset.org"
          onClick={() => setModal("sidecar")}
        />
        <SettingsSectionRow
          icon="🧩"
          title="Site compatibility"
          sub="Let older Chia sites recognize Loroco"
          onClick={() => setModal("compat")}
        />
      </ul>

      <h3>Tools</h3>
      <ul className="settings-section-list">
        <SettingsSectionRow
          icon="🔎"
          title="Inspect offer"
          sub="Decode an offer1… string"
          onClick={() => setModal("offer")}
        />
      </ul>

      <h3>Danger zone</h3>
      {!confirmingReset && (
        <button className="danger" onClick={() => setConfirmingReset(true)}>
          Remove this wallet
        </button>
      )}
      {confirmingReset && (
        <>
          <p className="muted">
            This deletes the encrypted seed from this browser. Make sure you have your
            recovery phrase before continuing.
          </p>
          <div className="row">
            <button className="secondary" onClick={() => setConfirmingReset(false)}>
              Cancel
            </button>
            <button className="danger" onClick={() => void resetWallet()}>
              Remove
            </button>
          </div>
        </>
      )}

      {modal === "recovery" && (
        <Modal title="Recovery phrase" onClose={closeModal}>
          <RecoveryPhraseSection wallet={wallet} />
        </Modal>
      )}
      {modal === "connections" && (
        <Modal title="Connected sites" onClose={closeModal}>
          <ConnectionsList />
        </Modal>
      )}
      {modal === "sidecar" && (
        <Modal title="Local peer sync" onClose={closeModal}>
          <LocalPeerSyncSection />
        </Modal>
      )}
      {modal === "compat" && (
        <Modal title="Site compatibility" onClose={closeModal}>
          <DAppCompatSection />
        </Modal>
      )}
      {modal === "notifications" && (
        <Modal title="Notifications" onClose={closeModal}>
          <NotificationsSection />
        </Modal>
      )}
      {modal === "offer" && (
        <Modal title="Inspect offer" onClose={closeModal}>
          <OfferInspector />
        </Modal>
      )}
    </div>
  );
}

function SettingsSectionRow({
  icon,
  title,
  sub,
  onClick,
}: {
  icon: string;
  title: string;
  sub?: string;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" className="settings-section-row" onClick={onClick}>
        <span className="settings-section-icon" aria-hidden>
          {icon}
        </span>
        <span className="settings-section-meta">
          <span className="settings-section-title">{title}</span>
          {sub && <span className="settings-section-sub">{sub}</span>}
        </span>
        <span className="settings-section-chev" aria-hidden>
          ›
        </span>
      </button>
    </li>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="modal-card">
        <div className="modal-header">
          <h3 className="modal-title">{title}</h3>
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function RecoveryPhraseSection({ wallet }: { wallet: StoredWallet }) {
  const [revealPwd, setRevealPwd] = useState("");
  const [revealedMnemonic, setRevealedMnemonic] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const revealSeed = async () => {
    setRevealError(null);
    try {
      const res = await callEngine<{ mnemonic: string }>("unlock_keychain", {
        keychain_blob: wallet.keychainBlob,
        fingerprint: wallet.fingerprint,
        password: revealPwd,
      });
      setRevealedMnemonic(res.mnemonic);
    } catch (err) {
      setRevealError((err as Error).message);
    }
  };

  if (revealedMnemonic) {
    return (
      <>
        <p className="muted small">
          Write these 24 words on paper and keep them offline. Anyone with this
          phrase controls the wallet.
        </p>
        <div className="seed-grid">
          {revealedMnemonic.split(/\s+/).map((w, i) => (
            <span className="seed-pill" key={i}>
              <span className="seed-pill-index">{i + 1}</span>
              <span className="seed-pill-word">{w}</span>
            </span>
          ))}
        </div>
        <button
          className="secondary"
          onClick={() => {
            setRevealedMnemonic(null);
            setRevealPwd("");
          }}
        >
          Hide
        </button>
      </>
    );
  }

  return (
    <>
      <p className="muted">Enter your password to view the 24-word seed.</p>
      <input
        type="password"
        placeholder="Password"
        value={revealPwd}
        onChange={(e) => setRevealPwd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && revealPwd) void revealSeed();
        }}
        autoFocus
      />
      {revealError && <p className="error">{revealError}</p>}
      <button onClick={() => void revealSeed()} disabled={!revealPwd}>
        Reveal
      </button>
    </>
  );
}

function StatusTab({ sync }: { sync: SyncState | null }) {
  return (
    <div className="tab-body">
      <h3>Network</h3>
      <div className="result">
        <div>
          <span className="muted">endpoint</span>
          <code>api.coinset.org · mainnet</code>
        </div>
        {sync && (
          <div>
            <span className="muted">peak height</span>
            <code>#{sync.peak_height.toLocaleString()}</code>
          </div>
        )}
        {sync?.error && (
          <div>
            <span className="muted">last error</span>
            <code className="error">{sync.error}</code>
          </div>
        )}
      </div>

      <h3>Sync details</h3>
      <SyncDetailsPanel />

      <h3>Mempool</h3>
      <MempoolDebugPanel />

      <h3>Local peer</h3>
      <LocalPeerStatus />
    </div>
  );
}

function MempoolDebugPanel() {
  const [snap, setSnap] = useState<MempoolDebugSnapshot | null>(null);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [showRaw, setShowRaw] = useState(false);
  const [, tick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await getMempoolDebug();
        if (!cancelled) setSnap(s);
      } catch {
        // best-effort
      }
    };
    void refresh();
    const id = setInterval(refresh, 2000);
    const rerender = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      clearInterval(rerender);
    };
  }, []);

  if (!snap) {
    return (
      <div className="result">
        <div>
          <span className="muted">status</span>
          <code>loading…</code>
        </div>
      </div>
    );
  }

  const { stats, feed } = snap;
  const filtered =
    filter === "mine"
      ? feed.filter((e) => e.mine === "incoming" || e.mine === "outgoing" || e.mine === "both")
      : feed;

  return (
    <>
      <div className="result">
        <div>
          <span className="muted">socket</span>
          <code className={stats.socketOpen ? "" : "error"}>
            {stats.socketState}
          </code>
        </div>
        <div>
          <span className="muted">messages</span>
          <code>
            {stats.messages.toLocaleString()}{" "}
            <span className="muted small">· {stats.msgsPerSec.toFixed(1)}/s</span>
          </code>
        </div>
        <div>
          <span className="muted">last event</span>
          <code>
            {stats.lastEvent || "(none)"}{" "}
            {stats.lastSeenAt > 0 && (
              <span className="muted small">· {timeAgo(stats.lastSeenAt)}</span>
            )}
          </code>
        </div>
        <div>
          <span className="muted">by type</span>
          <code>
            {Object.entries(stats.eventTypes)
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => `${t}:${n}`)
              .join(" · ") || "—"}
          </code>
        </div>
        {stats.rawSamples.length > 0 && (
          <div>
            <span className="muted">raw samples</span>
            <code>
              <button
                className="btn-small"
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "hide" : `show (${stats.rawSamples.length})`}
              </button>
            </code>
          </div>
        )}
        {showRaw && (
          <div>
            <pre
              style={{
                fontSize: 10,
                maxHeight: 160,
                overflow: "auto",
                background: "var(--surface-2)",
                padding: 6,
                borderRadius: 6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {stats.rawSamples.join("\n---\n")}
            </pre>
          </div>
        )}
      </div>

      <div className="form-input-row" style={{ marginTop: 8 }}>
        <button
          className={filter === "all" ? "btn-small active" : "btn-small"}
          onClick={() => setFilter("all")}
        >
          All ({feed.length})
        </button>
        <button
          className={filter === "mine" ? "btn-small active" : "btn-small"}
          onClick={() => setFilter("mine")}
        >
          Mine only
        </button>
      </div>

      {filtered.length === 0 ? (
        <p className="form-note">
          No transactions captured yet. Tx will appear here as the WS receives
          them (mainnet sees a few per minute on average).
        </p>
      ) : (
        <ul className="mempool-feed">
          {filtered.map((entry) => (
            <MempoolFeedRow key={entry.tx_id} entry={entry} />
          ))}
        </ul>
      )}
    </>
  );
}

function MempoolFeedRow({ entry }: { entry: MempoolDebugEntry }) {
  const mineClass =
    entry.mine === "incoming"
      ? "mine-in"
      : entry.mine === "outgoing"
        ? "mine-out"
        : entry.mine === "both"
          ? "mine-both"
          : entry.mine === "none"
            ? "mine-none"
            : "mine-unknown";
  const mineLabel =
    entry.mine === "incoming"
      ? "INCOMING"
      : entry.mine === "outgoing"
        ? "OUTGOING"
        : entry.mine === "both"
          ? "SELF"
          : entry.mine === "none"
            ? "not mine"
            : "no wallet";
  return (
    <li className={`mempool-feed-row ${mineClass}`} title={entry.tx_id}>
      <div className="mempool-feed-head">
        <span className={`mempool-mine-tag ${mineClass}`}>{mineLabel}</span>
        <span className="mempool-shape muted small">{entry.shape}</span>
        <span className="muted small">{timeAgo(entry.observed_at)}</span>
      </div>
      <div className="mempool-feed-body">
        <code className="mempool-txid">
          {entry.tx_id.slice(0, 10)}…{entry.tx_id.slice(-6)}
        </code>
        <span className="muted small">
          +{entry.additions_count} / −{entry.removals_count} coins
        </span>
      </div>
      <div className="mempool-feed-body">
        <span className="muted small">added</span>{" "}
        <code>{formatMojos(entry.total_added_mojos)}</code>
        <span className="muted small" style={{ marginLeft: 8 }}>
          removed
        </span>{" "}
        <code>{formatMojos(entry.total_removed_mojos)}</code>
      </div>
      {(entry.matched_in_phs.length > 0 ||
        entry.matched_out_cat_assets.length > 0 ||
        entry.matched_out_xch) && (
        <div className="mempool-feed-body">
          {entry.matched_in_phs.length > 0 && (
            <span className="muted small">
              in→ {entry.matched_in_phs[0]!.slice(0, 10)}…
              {entry.matched_in_phs.length > 1
                ? ` (+${entry.matched_in_phs.length - 1})`
                : ""}
            </span>
          )}
          {entry.matched_out_xch && (
            <span className="muted small" style={{ marginLeft: 8 }}>
              out: XCH
            </span>
          )}
          {entry.matched_out_cat_assets.length > 0 && (
            <span className="muted small" style={{ marginLeft: 8 }}>
              out: CAT {entry.matched_out_cat_assets[0]!.slice(0, 8)}…
              {entry.matched_out_cat_assets.length > 1
                ? ` (+${entry.matched_out_cat_assets.length - 1})`
                : ""}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function formatMojos(mojos: string): string {
  try {
    const n = BigInt(mojos);
    if (n === 0n) return "0";
    // Show XCH if > 1 billion mojos (i.e. > 0.001 XCH), otherwise raw mojos.
    if (n >= 1_000_000_000n) {
      const xch = Number(n) / 1_000_000_000_000;
      return `${xch.toFixed(xch < 0.01 ? 6 : 4)} XCH`;
    }
    return `${n.toString()} mojos`;
  } catch {
    return mojos;
  }
}

function LocalPeerStatus() {
  const [settings, setSettings] = useState<SidecarSettings | null>(null);
  const [probe, setProbeState] = useState<SidecarProbe | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await getSidecarSettings();
        if (!cancelled) setSettings(s);
      } catch {
        // best-effort
      }
    };
    void refresh();
  }, []);

  useEffect(() => {
    if (!settings) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const p = await probeSidecar();
        if (!cancelled) setProbeState(p);
      } catch (err) {
        if (!cancelled) setProbeState({ reachable: false, error: (err as Error).message });
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [settings?.enabled, settings?.url]);

  if (!settings) return <p className="muted small">Loading…</p>;

  const reachable =
    probe && "peer_connected" in probe && probe.peer_connected === true;
  const probeError = probe && "error" in probe && probe.error ? probe.error : null;

  return (
    <div className="result">
      <div>
        <span className="muted">mode</span>
        <code>{settings.enabled ? "sidecar (when reachable)" : "coinset.org only"}</code>
      </div>
      <div>
        <span className="muted">url</span>
        <code>{settings.url}</code>
      </div>
      <div>
        <span className="muted">status</span>
        {reachable ? (
          <code style={{ color: "var(--ok, #4ade80)" }}>
            connected · {probe?.peer_addr ?? "?"} · peak #
            {probe?.peak_height?.toLocaleString() ?? "?"}
          </code>
        ) : settings.enabled ? (
          <code style={{ color: "var(--warn, #fbbf24)" }}>
            unreachable {probeError ? `(${probeError})` : ""}
          </code>
        ) : (
          <code className="muted">disabled</code>
        )}
      </div>
    </div>
  );
}

function SyncBadge({
  sync,
  telemetry,
}: {
  sync: SyncState | null;
  telemetry: CoinSyncTelemetry | null;
}) {
  const [open, setOpen] = useState(false);
  // 1 Hz tick so the elapsed-seconds counter and "x ago" labels keep moving
  // even when telemetry itself doesn't change between alarm fires.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Click outside the badge / Esc closes the popover.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (!t.closest(".sync-badge")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const stage = telemetry?.stage ?? "idle";
  const isScanning = stage === "deriving" || stage === "xch" || stage === "cats" || stage === "nfts";
  const chainSynced = !!sync?.synced;
  const chainOffline = !!sync?.error;
  const hadFullSync = !!telemetry?.last_full_sync_at;

  // Status word: distinguish "first-time scanning" (no prior full sync) from
  // "refreshing" (have a baseline, just freshening). User reported that
  // showing "0/9 chunks" after every tick felt like we were starting over —
  // we are NOT, the store keeps the prior data, only the progress counters
  // reset. So when we already have a baseline, label it 'refreshing'.
  let topWord: string;
  let topClass: string;
  if (chainOffline) {
    topWord = "offline";
    topClass = "err";
  } else if (isScanning && hadFullSync) {
    topWord = "refreshing";
    topClass = "warn";
  } else if (isScanning) {
    topWord = "syncing";
    topClass = "warn";
  } else if (chainSynced) {
    topWord = "synced";
    topClass = "ok";
  } else {
    topWord = "connecting";
    topClass = "muted";
  }

  const sp = telemetry?.stage_progress;
  const xchP = sp?.xch ?? { done: 0, total: 0 };
  const catsP = sp?.cats ?? { done: 0, total: 0, found: 0 };
  const nftsP = sp?.nfts ?? { done: 0, total: 0, found: 0 };

  const dotClass = chainOffline
    ? "dot-err"
    : isScanning
      ? "dot-warn"
      : chainSynced
        ? "dot-ok"
        : "dot-muted";

  const tooltip = isScanning
    ? `${topWord} · ${stageDisplay(stage)}`
    : telemetry?.last_error
      ? `Last error: ${telemetry.last_error}`
      : sync
        ? `${topWord} · peak #${sync.peak_height.toLocaleString()}`
        : topWord;

  const totals = telemetry?.totals;
  const xchCoins = totals?.xch_coins ?? 0;
  const catAssets = totals?.cat_assets ?? 0;
  const nfts = totals?.nfts ?? 0;

  // Compute overall % across all 3 stages so the collapsed badge can show a
  // single progress hint without the user having to expand. Each stage
  // contributes equally — the bar advances as XCH → CATs → NFTs complete.
  const overall = computeOverallProgress(stage, xchP, nftsP);

  // Elapsed seconds since the tick started — gives the user a "we're alive"
  // signal even when chunk counters are slow.
  const elapsedSec =
    isScanning && telemetry?.tick_started_at
      ? Math.max(0, Math.floor((Date.now() - telemetry.tick_started_at) / 1000))
      : 0;

  return (
    <div className={"sync-badge" + (open ? " open" : "")}>
      <button
        type="button"
        className="sync-badge-summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Sync status"
        title={tooltip}
      >
        <span className={"sync-dot " + dotClass} aria-hidden />
        <span className={"sync-word " + topClass}>{topWord}</span>
        {isScanning && elapsedSec > 0 && (
          <span className="sync-elapsed muted" title="Elapsed since tick start">
            {elapsedSec}s
          </span>
        )}
        <span className="sync-chev" aria-hidden>{open ? "▴" : "▾"}</span>
      </button>
      {isScanning && !open && (
        <div className="sync-mini-bar" aria-hidden>
          <div
            className="sync-mini-bar-fill"
            style={{ width: `${Math.round(overall * 100)}%` }}
          />
        </div>
      )}

      {open && (
        <div className="sync-badge-detail">
          {sync && !chainOffline && (
            <header className="sync-detail-header">
              <span className="sync-detail-sub">
                peak <code>#{sync.peak_height.toLocaleString()}</code>
              </span>
              {isScanning && (
                <span className="sync-detail-stage">{stageDisplay(stage)}</span>
              )}
            </header>
          )}
          {chainOffline && (
            <header className="sync-detail-header">
              <span className="sync-detail-sub err">network unreachable</span>
            </header>
          )}

          <ul className="sync-stage-list">
            <SyncStageItem
              label="XCH"
              active={stage === "xch"}
              prog={xchP}
              count={xchCoins}
              countLabel={xchCoins === 1 ? "coin" : "coins"}
              hadFullSync={hadFullSync}
            />
            <SyncStageItem
              label="CATs"
              active={stage === "cats" || stage === "nfts"}
              prog={stage === "nfts" ? nftsP : catsP}
              count={catAssets}
              countLabel={catAssets === 1 ? "token" : "tokens"}
              hadFullSync={hadFullSync}
              sharedNote={stage === "nfts" ? "shared scan with NFTs" : undefined}
            />
            <SyncStageItem
              label="NFTs"
              active={stage === "nfts"}
              prog={nftsP}
              count={nfts}
              countLabel={nfts === 1 ? "NFT" : "NFTs"}
              hadFullSync={hadFullSync}
            />
          </ul>

          {(telemetry?.last_full_sync_at || telemetry?.last_success_at) && (
            <div className="sync-detail-foot">
              <span className="muted small">
                {telemetry.last_full_sync_at
                  ? `Last full sync ${timeAgo(telemetry.last_full_sync_at)}`
                  : `Last tick ${timeAgo(telemetry.last_success_at!)}`}
              </span>
            </div>
          )}

          {telemetry?.last_error && (
            <div className="sync-detail-error small" title={telemetry.last_error}>
              {telemetry.last_error}
            </div>
          )}

          <button
            className="sync-refresh"
            onClick={() => void forceCoinSync().catch(() => {})}
            disabled={isScanning}
          >
            {isScanning ? "Refreshing…" : "Refresh now"}
          </button>
        </div>
      )}
    </div>
  );
}

function SyncStageItem({
  label,
  active,
  prog,
  count,
  countLabel,
  hadFullSync,
  sharedNote,
}: {
  label: string;
  active: boolean;
  prog: StageProgress;
  count: number;
  countLabel: string;
  hadFullSync: boolean;
  sharedNote?: string;
}) {
  const done = prog.total > 0 && prog.done >= prog.total;
  const pct = prog.total > 0 ? Math.min(100, (prog.done / prog.total) * 100) : 0;

  // State: 'idle' (waiting in pipeline), 'active' (currently scanning),
  // 'done' (finished this tick). If we had a prior full sync and we're not
  // active, render as 'ok' — we have data, even if today's chunk count is 0.
  let dot: "ok" | "warn" | "muted";
  if (active && !done) dot = "warn";
  else if (done || hadFullSync) dot = "ok";
  else dot = "muted";

  const stageElapsedSec =
    active && prog.started_at
      ? Math.max(0, Math.floor((Date.now() - prog.started_at) / 1000))
      : 0;

  return (
    <li className="sync-stage-item" title={prog.last_warning ?? ""}>
      <span className={`sync-stage-dot ${dot}`} aria-hidden />
      <span className="sync-stage-label">{label}</span>
      <span className="sync-stage-count">
        {count} <span className="muted">{countLabel}</span>
      </span>
      {active && (
        <span className="sync-stage-detail">
          {sharedNote
            ? sharedNote
            : `${prog.done}/${prog.total}${prog.detail ? ` · ${prog.detail}` : ""}${stageElapsedSec > 0 ? ` · ${stageElapsedSec}s` : ""}`}
        </span>
      )}
      {active && !sharedNote && (
        <div className="sync-stage-bar" aria-hidden>
          <div className="sync-stage-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
}

function computeOverallProgress(
  stage: SyncStage,
  xch: StageProgress,
  nfts: StageProgress,
): number {
  // The background runs xch → nfts → done. The nfts stage's hint scan
  // populates both CAT and NFT queues; the "cats" SyncStage value exists for
  // per-substage progress but is never set as the active stage. So the bar
  // is split in halves: XCH first half, shared NFT+CAT scan second half.
  const ratio = (p: StageProgress) =>
    p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  const xchR = ratio(xch);
  const nftsR = ratio(nfts);
  if (stage === "deriving") return 0.02;
  if (stage === "xch") return xchR / 2;
  if (stage === "nfts" || stage === "cats") return 0.5 + nftsR / 2;
  if (stage === "done") return 1;
  return 0;
}

function stageDisplay(stage: SyncStage): string {
  switch (stage) {
    case "deriving":
      return "Deriving addresses";
    case "xch":
      return "Scanning XCH";
    case "cats":
      return "Parsing CATs";
    case "nfts":
      return "Scanning hints (CATs + NFTs)";
    case "done":
      return "Idle";
    case "idle":
    default:
      return "Idle";
  }
}

function formatUsd(n: number): string {
  if (!isFinite(n) || n === 0) return "0.00";
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(4);
  return n.toFixed(6);
}

function HomeTab({
  balance,
  balanceError,
  onRefresh,
  wallet,
  xchPrice,
}: {
  balance: BalanceInfo | null;
  balanceError: string | null;
  onRefresh: () => void;
  wallet: StoredWallet;
  xchPrice: number | null;
}) {
  const [snapshot, setSnapshot] = useState<CoinSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await getCoinSnapshot(wallet.fingerprint);
        if (!cancelled) setSnapshot(s);
      } catch {
        // best-effort
      }
    };
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [wallet.fingerprint]);

  const cats = snapshot?.cats ? Object.values(snapshot.cats) : [];
  const catsWithBalance = cats.filter((c) => c.unspent_coin_count > 0);
  const nftCount = snapshot?.nfts
    ? Object.values(snapshot.nfts).filter((n) => !n.spent).length
    : 0;
  const metadata = snapshot?.cat_metadata ?? {};
  // Pull XCH balance from the local coin store snapshot — it includes
  // hint-matched + hardened-derived coins that get_address_balance misses.
  const xchMojosStr = snapshot?.unspent_mojos ?? "0";
  const xchDisplay = mojosToXch(xchMojosStr);
  const xchUnspentCount = snapshot?.unspent_count ?? balance?.unspent_coin_count ?? 0;
  const xchAmount = Number(BigInt(xchMojosStr)) / 1_000_000_000_000;
  const xchUsdValue = xchPrice ? xchAmount * xchPrice : null;

  return (
    <div className="tab-body">
      <ul className="asset-list">
        {/* XCH always first */}
        <li className="asset-row">
          <div className="asset-icon asset-icon-xch">XCH</div>
          <div className="asset-meta">
            <div className="asset-name">Chia</div>
            <div className="muted small">
              {xchUnspentCount} coin{xchUnspentCount === 1 ? "" : "s"}
              {xchPrice ? ` · $${xchPrice.toFixed(4)}/XCH` : ""}
            </div>
          </div>
          <div className="asset-balance">
            <div>{xchDisplay}</div>
            <div className="muted small">
              {xchUsdValue != null ? `≈ $${formatUsd(xchUsdValue)}` : "XCH"}
            </div>
          </div>
        </li>

        {/* CATs sorted by amount desc */}
        {catsWithBalance
          .slice()
          .sort((a, b) =>
            BigInt(b.total_unspent_mojos) > BigInt(a.total_unspent_mojos) ? 1 : -1,
          )
          .map((c) => {
            const meta = metadata[c.asset_id] ?? metadata[normalizeId(c.asset_id)];
            const ticker = meta?.code ?? "CAT";
            const name = meta?.name ?? shortHash(c.asset_id);
            const decimals = meta?.decimals ?? 3;
            return (
              <li key={c.asset_id} className="asset-row" title={c.asset_id}>
                {meta?.image_url ? (
                  <img
                    src={meta.image_url}
                    alt={name}
                    className="asset-icon asset-icon-img"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div className="asset-icon asset-icon-cat">
                    {ticker.slice(0, 3).toUpperCase()}
                  </div>
                )}
                <div className="asset-meta">
                  <div className="asset-name">{name}</div>
                  <div className="muted small">
                    {c.unspent_coin_count} coin{c.unspent_coin_count === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="asset-balance">
                  <div>{formatCatAmount(c.total_unspent_mojos, decimals)}</div>
                  <div className="muted small">{ticker}</div>
                </div>
              </li>
            );
          })}
      </ul>

      {nftCount > 0 && (
        <p className="muted small">
          You hold {nftCount} NFT{nftCount === 1 ? "" : "s"}. See the NFTs tab.
        </p>
      )}

      {balanceError && <p className="error">{balanceError}</p>}
    </div>
  );
}

interface DecodedOffer {
  offered: {
    xch_mojos: string;
    cats: Array<{ asset_id: string; amount: string }>;
    nft_launcher_ids: string[];
  };
  requested: {
    xch_mojos: string;
    cats: Array<{ asset_id: string; amount: string }>;
    nft_launcher_ids: string[];
  };
  coin_spends_count: number;
  offered_royalties: Array<{
    nft_launcher_id: string;
    royalty_basis_points: number;
  }>;
}

function SyncDetailsPanel() {
  const [telemetry, setTelemetry] = useState<CoinSyncTelemetry | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [t, s] = await Promise.all([getCoinSyncTelemetry(), getSyncState()]);
        if (!cancelled) {
          setTelemetry(t);
          setSync(s);
        }
      } catch {
        // best-effort
      }
    };
    void refresh();
    const id = setInterval(refresh, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onForce = async () => {
    setBusy(true);
    try {
      await forceCoinSync();
    } finally {
      setBusy(false);
    }
  };

  const xch = telemetry?.stage_progress.xch;
  const cats = telemetry?.stage_progress.cats;
  const nfts = telemetry?.stage_progress.nfts;
  const t = telemetry; // shorthand

  return (
    <div className="sync-details">
      <div className="result">
        <div>
          <span className="muted">stage</span>
          <code>{t?.stage ?? "(idle)"}</code>
        </div>
        {sync && (
          <div>
            <span className="muted">network peak</span>
            <code>#{sync.peak_height.toLocaleString()}</code>
          </div>
        )}
        <div>
          <span className="muted">last full sync</span>
          <code>{t?.last_full_sync_at ? new Date(t.last_full_sync_at).toLocaleString() : "(never)"}</code>
        </div>
        <div>
          <span className="muted">last tick</span>
          <code>{t?.last_success_at ? new Date(t.last_success_at).toLocaleString() : "(never)"}</code>
        </div>
        {t?.last_error && (
          <div>
            <span className="muted">last error</span>
            <code className="error">{t.last_error}</code>
          </div>
        )}
      </div>

      <SyncStageDetailRow label="XCH" stage="xch" progress={xch} count={t?.totals.xch_coins} unit="coins" />
      <SyncStageDetailRow label="CATs" stage="cats" progress={cats} count={t?.totals.cat_assets} unit="tokens" />
      <SyncStageDetailRow label="NFTs" stage="nfts" progress={nfts} count={t?.totals.nfts} unit="NFTs" />

      <button className="sync-refresh" onClick={() => void onForce()} disabled={busy}>
        {busy ? "Triggering…" : "Force full re-scan"}
      </button>
    </div>
  );
}

function SyncStageDetailRow({
  label,
  stage,
  progress,
  count,
  unit,
}: {
  label: string;
  stage: SyncStage;
  progress: StageProgress | undefined;
  count: number | undefined;
  unit: string;
}) {
  const p = progress;
  const done = p && p.total > 0 && p.done >= p.total;
  return (
    <div className="result">
      <div>
        <span className="muted">{label}</span>
        <code>
          {count ?? 0} {unit}
          {p && p.total > 0 && (
            <span className="muted small" style={{ marginLeft: 6 }}>
              · {p.done}/{p.total} chunks {done ? "✓" : ""}
            </span>
          )}
        </code>
      </div>
      {p?.block_from != null && (
        <div>
          <span className="muted">block range</span>
          <code>
            #{p.block_from.toLocaleString()}
            {p.block_to != null && p.block_to !== p.block_from && (
              <> → #{p.block_to.toLocaleString()}</>
            )}
          </code>
        </div>
      )}
      {p?.detail && (
        <div>
          <span className="muted">scanning</span>
          <code>{p.detail}</code>
        </div>
      )}
      {p?.candidates != null && (
        <div>
          <span className="muted">candidates</span>
          <code>{p.candidates}</code>
        </div>
      )}
      {p?.last_warning && (
        <div>
          <span className="muted">last warning</span>
          <code className="error" title={p.last_warning}>
            {p.last_warning.slice(0, 80)}
          </code>
        </div>
      )}
      {void stage}
    </div>
  );
}

function LocalPeerSyncSection() {
  const [settings, setSettings] = useState<SidecarSettings | null>(null);
  const [urlInput, setUrlInput] = useState("");
  const [probe, setProbeState] = useState<SidecarProbe | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = await getSidecarSettings();
      setSettings(s);
      setUrlInput((u) => (u === "" ? s.url : u));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const probeNow = async (url?: string) => {
    try {
      const p = await probeSidecar(url);
      setProbeState(p);
    } catch (err) {
      setProbeState({ reachable: false, error: (err as Error).message });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!settings) return;
    void probeNow();
    const id = setInterval(() => void probeNow(), 5000);
    return () => clearInterval(id);
  }, [settings?.enabled, settings?.url]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const s = await setSidecarSettings({ enabled: next });
      setSettings(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const saveUrl = async () => {
    setBusy(true);
    try {
      const s = await setSidecarSettings({ url: urlInput.trim() });
      setSettings(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <p className="muted small">Loading…</p>;

  const reachable =
    probe && "peer_connected" in probe && probe.peer_connected === true;
  const probeError =
    probe && "error" in probe && probe.error ? probe.error : null;

  return (
    <>
      <p className="form-note">
        Run a local <code>ozone-sidecar</code> daemon to sync your wallet
        through real Chia peers (mTLS) instead of coinset.org. The extension
        falls back automatically if the sidecar is unreachable.
      </p>
      <label className="form-check">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Use sidecar when reachable</span>
      </label>
      <div className="form-input-row">
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="http://127.0.0.1:8765"
        />
        <button
          className="secondary modal-inline-btn"
          disabled={busy || urlInput === settings.url}
          onClick={() => void saveUrl()}
        >
          Save
        </button>
      </div>
      <div className="form-status">
        <span className="label">status</span>
        {reachable ? (
          <code className="ok">
            connected · {probe?.peer_addr ?? "?"} · peak #
            {probe?.peak_height?.toLocaleString() ?? "?"}
          </code>
        ) : settings.enabled ? (
          <code className="warn">
            unreachable {probeError ? `(${probeError})` : ""}
          </code>
        ) : (
          <code className="muted">disabled — coinset.org in use</code>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function DAppCompatSection() {
  const [settings, setSettings] = useState<CompatSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = await getCompatSettings();
        setSettings(s);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const s = await setCompatSettings({ legacyGoby: next });
      setSettings(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <p className="muted small">Loading…</p>;

  return (
    <>
      <p className="form-note">
        Some older Chia sites only look for the Goby wallet by name. Turn
        this on and those sites will find Loroco the same way. If you
        already have Goby installed, leave it off so the two don't
        clash.
      </p>
      <label className="form-check">
        <input
          type="checkbox"
          checked={settings.legacyGoby}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Let older sites recognize Loroco as Goby</span>
      </label>
      <p className="muted small">
        Reload any open dApp tabs after changing this — the wallet only
        injects its provider once per page load.
      </p>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function NotificationsSection() {
  const [settings, setSettings] = useState<NotifSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setSettings(await getNotifSettings());
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, []);

  const patch = async (p: Partial<NotifSettings>) => {
    setBusy(true);
    try {
      setSettings(await setNotifSettings(p));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return <p className="muted small">Loading…</p>;

  const SUB: Array<{ key: keyof NotifSettings; label: string }> = [
    { key: "incomingConfirmed", label: "Payment received" },
    { key: "outgoingConfirmed", label: "Your transaction confirmed" },
    { key: "outgoingExternal", label: "Funds spent from another device" },
  ];

  return (
    <>
      <p className="form-note">
        Get alerted when a payment lands in your wallet, when one of your
        transactions confirms, or when your seed is spent from another
        wallet/device. Alerts fire as transactions confirm on-chain.
      </p>
      <label className="form-check">
        <input
          type="checkbox"
          checked={settings.enabled}
          disabled={busy}
          onChange={(e) => void patch({ enabled: e.target.checked })}
        />
        <span>
          <strong>Enable notifications</strong>
        </span>
      </label>
      <div style={{ opacity: settings.enabled ? 1 : 0.5, marginTop: 6 }}>
        {SUB.map((s) => (
          <label className="form-check" key={s.key}>
            <input
              type="checkbox"
              checked={settings[s.key]}
              disabled={busy || !settings.enabled}
              onChange={(e) => void patch({ [s.key]: e.target.checked })}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
      <p className="muted small">
        Your browser may also ask for permission to show notifications the first
        time one fires.
      </p>
      {error && <p className="error">{error}</p>}
    </>
  );
}

function ConnectionsList() {
  const [conns, setConns] = useState<ConnectionRecord[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const list = await listConnections();
      setConns(list);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  const onRevoke = async (origin: string) => {
    setRevoking(origin);
    try {
      await revokeConnection(origin);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRevoking(null);
    }
  };

  if (conns === null) {
    return <p className="muted small">Loading connections…</p>;
  }

  if (conns.length === 0) {
    return (
      <div className="empty-block">
        <p className="muted">
          No connected sites yet. Sites you approve will appear here so you can
          revoke them any time.
        </p>
      </div>
    );
  }

  return (
    <ul className="connections-list">
      {conns.map((c) => {
        let host = c.origin;
        try {
          host = new URL(c.origin).host;
        } catch {
          // keep raw origin
        }
        const readOnly = c.scope === "read-only";
        const msLeft = (c.expiresAt ?? 0) - Date.now();
        const daysLeft = Math.max(0, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
        const expiryLabel =
          msLeft <= 0
            ? "expired"
            : daysLeft <= 1
              ? "expires within a day"
              : `expires in ${daysLeft} days`;
        return (
          <li key={c.origin} className="connection-row">
            <div className="connection-meta">
              <div className="connection-host" title={c.origin}>
                {host}
                <span className={`scope-badge ${readOnly ? "read-only" : "full"}`}>
                  {readOnly ? "read-only" : "full access"}
                </span>
              </div>
              <div className="muted small">
                Connected {new Date(c.connectedAt).toLocaleDateString()} ·{" "}
                {expiryLabel}
              </div>
            </div>
            <button
              className="ghost connection-revoke"
              disabled={revoking === c.origin}
              onClick={() => void onRevoke(c.origin)}
            >
              {revoking === c.origin ? "…" : "Disconnect"}
            </button>
          </li>
        );
      })}
      {error && <li className="error small">{error}</li>}
    </ul>
  );
}

function OfferInspector() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DecodedOffer | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inspect = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await callEngine<DecodedOffer>("decode_offer", { offer: text.trim() });
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <textarea
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="offer1..."
        spellCheck={false}
      />
      <button onClick={() => void inspect()} disabled={busy || !text.trim()}>
        {busy ? "Decoding…" : "Decode offer"}
      </button>
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="result">
          {BigInt(result.offered.xch_mojos || "0") > 0n && (
            <div>
              <span className="muted">offered XCH</span>
              <code>{mojosToXch(result.offered.xch_mojos)} XCH</code>
            </div>
          )}
          {result.offered.cats.map((c) => (
            <div key={c.asset_id}>
              <span className="muted">offered CAT {shortHash(c.asset_id)}</span>
              <code>{mojosToCatUnits(c.amount)} CAT</code>
            </div>
          ))}
          {result.offered.nft_launcher_ids.map((l) => (
            <div key={l}>
              <span className="muted">offered NFT</span>
              <code>{shortHash(l)}</code>
            </div>
          ))}
          {BigInt(result.requested.xch_mojos || "0") > 0n && (
            <div>
              <span className="muted">requested XCH</span>
              <code>{mojosToXch(result.requested.xch_mojos)} XCH</code>
            </div>
          )}
          {result.requested.cats.map((c) => (
            <div key={c.asset_id}>
              <span className="muted">requested CAT {shortHash(c.asset_id)}</span>
              <code>{mojosToCatUnits(c.amount)} CAT</code>
            </div>
          ))}
          {result.requested.nft_launcher_ids.map((l) => (
            <div key={l}>
              <span className="muted">requested NFT</span>
              <code>{shortHash(l)}</code>
            </div>
          ))}
          {result.offered_royalties.length > 0 && (
            <div>
              <span className="muted">royalties</span>
              <code>
                {result.offered_royalties
                  .map((r) => `${(r.royalty_basis_points / 100).toFixed(2)}%`)
                  .join(", ")}
              </code>
            </div>
          )}
          <div>
            <span className="muted">coin spends</span>
            <code>{result.coin_spends_count}</code>
          </div>
        </div>
      )}
    </>
  );
}

// NFT thumbnail that falls back to the "NFT" placeholder when the image is
// missing OR fails to load — previously a broken URL collapsed the card to a
// blank square (the onError just hid the <img>).
function NftThumb({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <div className="nft-placeholder">NFT</div>;
  return <img src={src} alt={alt} onError={() => setFailed(true)} />;
}

function NftsTab({ wallet }: { wallet: StoredWallet }) {
  const [snapshot, setSnapshot] = useState<CoinSnapshot | null>(null);
  const [telemetry, setTelemetry] = useState<CoinSyncTelemetry | null>(null);
  const [selected, setSelected] = useState<NftView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const [s, t] = await Promise.all([
          getCoinSnapshot(wallet.fingerprint),
          getCoinSyncTelemetry(),
        ]);
        if (!cancelled) {
          setSnapshot(s);
          setTelemetry(t);
        }
      } catch {
        // best-effort
      }
    };
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [wallet.fingerprint]);

  const nfts = snapshot?.nfts
    ? Object.values(snapshot.nfts).filter((n) => !n.spent)
    : [];

  if (selected) {
    return (
      <NftDetail
        wallet={wallet}
        nft={selected}
        onBack={() => setSelected(null)}
        snapshot={snapshot}
      />
    );
  }

  const scanningNfts =
    telemetry?.stage === "nfts" ||
    telemetry?.stage === "xch" ||
    telemetry?.stage === "cats" ||
    telemetry?.stage === "deriving";
  const nftProg = telemetry?.stage_progress.nfts;
  const lastFull = telemetry?.last_full_sync_at;
  const showProgress =
    nfts.length === 0 && (scanningNfts || (nftProg && nftProg.total > 0 && nftProg.done < nftProg.total));

  return (
    <div className="tab-body">
      <div className="row" style={{ alignItems: "center" }}>
        <div className="muted small" style={{ flex: 1 }}>
          {nfts.length > 0
            ? `${nfts.length} NFT${nfts.length === 1 ? "" : "s"}`
            : "Scanning hints for receipts"}
          {lastFull && ` · last full ${timeAgo(lastFull)}`}
        </div>
        <button
          className="sync-refresh"
          style={{ flex: "0 0 auto" }}
          onClick={() => void forceCoinSync().catch(() => {})}
        >
          Rescan ↻
        </button>
      </div>

      {nfts.length === 0 ? (
        <div className="empty-block">
          <p className="muted">
            {showProgress
              ? "Looking for NFTs at your derived addresses…"
              : "No NFTs detected. They appear here as soon as the next sync picks them up."}
          </p>
          {nftProg && nftProg.total > 0 && (
            <div className="stage-bar" style={{ marginTop: 8 }}>
              <div
                className={
                  "stage-bar-fill " +
                  (nftProg.done >= nftProg.total
                    ? "ok"
                    : scanningNfts
                      ? "warn"
                      : "")
                }
                style={{
                  width: `${Math.round((nftProg.done / Math.max(1, nftProg.total)) * 100)}%`,
                }}
              />
            </div>
          )}
          {nftProg && (
            <p className="muted small" style={{ marginTop: 6 }}>
              {nftProg.done}/{nftProg.total} chunks
              {nftProg.last_warning ? ` · last warning: ${nftProg.last_warning}` : ""}
            </p>
          )}
        </div>
      ) : (
        <div className="nft-grid">
          {nfts.map((n) => {
            const imgSrc = pickNftImage(n);
            return (
              <button
                key={n.launcher_id}
                className="nft-card"
                onClick={() => setSelected(n)}
              >
                <NftThumb src={imgSrc} alt={n.launcher_id} />
                <div className="nft-caption" title={n.launcher_id}>
                  #{(n.metadata.edition_number ?? 1).toString()}
                  {n.metadata.edition_total && n.metadata.edition_total > 1 ? (
                    <span className="muted">/{n.metadata.edition_total}</span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function NftDetail({
  wallet,
  nft,
  onBack,
  snapshot,
}: {
  wallet: StoredWallet;
  nft: NftView;
  onBack: () => void;
  snapshot: CoinSnapshot | null;
}) {
  const [transferring, setTransferring] = useState(false);
  const [recipient, setRecipient] = useState("");
  const [recipientValid, setRecipientValid] = useState<boolean | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ tx_id: string; status: string } | null>(null);

  // Validate recipient bech32m (XCH address) on every change.
  useEffect(() => {
    let cancelled = false;
    if (!recipient.trim()) {
      setRecipientValid(null);
      return;
    }
    void (async () => {
      try {
        await callEngine("decode_address", { address: recipient.trim() });
        if (!cancelled) setRecipientValid(true);
      } catch {
        if (!cancelled) setRecipientValid(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recipient]);

  const transfer = async () => {
    setSending(true);
    setSendError(null);
    setSent(null);
    try {
      // First, check if the NFT lives at a HARDENED derivation. The
      // engine's transfer_nft only signs with unhardened-derived keys
      // today, so we have to bail out clearly instead of silently
      // failing further down.
      const nftPh = nft.p2_puzzle_hash.toLowerCase();
      const hardenedMap = snapshot?.hardened_phs ?? {};
      // Try both 0x-prefixed and stripped to be tolerant of either key shape.
      const hardenedIdx =
        hardenedMap[nftPh] ??
        hardenedMap[nftPh.startsWith("0x") ? nftPh.slice(2) : `0x${nftPh}`];
      if (hardenedIdx !== undefined) {
        setSendError(
          `This NFT was received at a hardened derivation (index ${hardenedIdx}). ` +
            `The wallet engine's transfer_nft only signs with unhardened-derived ` +
            `keys today, so this transfer can't be completed from Loroco yet.`,
        );
        return;
      }

      // Then search unhardened derivations. 200 covers most legitimate
      // wallets — the earlier 50-cap was too tight for users who'd
      // generated a lot of receive addresses.
      const derived = await callEngine<{
        addresses: { index: number; puzzle_hash: string }[];
      }>("derive_addresses", {
        fingerprint: wallet.fingerprint,
        start: 0,
        count: 200,
        testnet: false,
      });
      const own = derived.addresses.find(
        (a) => a.puzzle_hash.toLowerCase() === nftPh,
      );
      if (!own) {
        setSendError(
          `Couldn't find this NFT's p2 puzzle hash (${nft.p2_puzzle_hash}) ` +
            `in either your first 200 unhardened derivations or your cached ` +
            `hardened paths. Try syncing again, or report this NFT for debugging.`,
        );
        return;
      }

      const res = await callEngine<{ tx_id: string; status: string; error?: string }>(
        "transfer_nft",
        {
          fingerprint: wallet.fingerprint,
          coin_id: nft.coin_id,
          parent_coin_info: nft.parent_coin_info,
          recipient_address: recipient.trim(),
          derivation_index: own.index,
          fee_mojos: "0",
          broadcast: true,
        },
      );
      setSent(res);
      if (res.error) setSendError(res.error);
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  const imgSrc = pickNftImage(nft);
  // Silence the snapshot-unused warning — we keep the prop in case we
  // want to derive royalties/recent activity later.
  void snapshot;
  return (
    <div className="tab-body">
      <button className="ghost" onClick={onBack}>
        ← Back to NFTs
      </button>
      {imgSrc && (
        <div className="nft-detail-image">
          <img src={imgSrc} alt={nft.launcher_id} />
        </div>
      )}
      <ul className="status-list">
        <li>
          <span className="muted">launcher</span>
          <code title={nft.launcher_id}>{shortHash(nft.launcher_id)}</code>
        </li>
        {nft.metadata.edition_total ? (
          <li>
            <span className="muted">edition</span>
            <span>
              {nft.metadata.edition_number ?? 1} / {nft.metadata.edition_total}
            </span>
          </li>
        ) : null}
        <li>
          <span className="muted">royalty</span>
          <span>{(nft.royalty_basis_points / 100).toFixed(2)}%</span>
        </li>
        {nft.current_owner_did && (
          <li>
            <span className="muted">DID</span>
            <code title={nft.current_owner_did}>{shortHash(nft.current_owner_did)}</code>
          </li>
        )}
      </ul>
      <details>
        <summary>URIs</summary>
        <div className="result">
          {(nft.metadata.data_uris ?? []).map((u) => (
            <div key={u}>
              <span className="muted">data</span>
              <code>{u}</code>
            </div>
          ))}
          {(nft.metadata.metadata_uris ?? []).map((u) => (
            <div key={u}>
              <span className="muted">metadata</span>
              <code>{u}</code>
            </div>
          ))}
        </div>
      </details>

      {!transferring && !sent && (
        <button onClick={() => setTransferring(true)}>Transfer NFT</button>
      )}

      {transferring && !sent && (
        <div className="result">
          <label className="field">
            <span>Recipient XCH address</span>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder="xch1..."
              spellCheck={false}
            />
            {recipientValid === true && (
              <span className="small ok">✓ valid xch address</span>
            )}
            {recipientValid === false && (
              <span className="small error">invalid bech32m</span>
            )}
          </label>
          {sendError && <p className="error">{sendError}</p>}
          <div className="row">
            <button
              className="secondary"
              onClick={() => {
                setTransferring(false);
                setRecipient("");
                setSendError(null);
              }}
              disabled={sending}
            >
              Cancel
            </button>
            <button
              onClick={() => void transfer()}
              disabled={sending || recipientValid !== true}
            >
              {sending ? "Transferring…" : "Confirm transfer"}
            </button>
          </div>
        </div>
      )}

      {sent && (
        <div className="result">
          <div>
            <span className="muted">tx id</span>
            <code>{sent.tx_id}</code>
          </div>
          <div>
            <span className="muted">status</span>
            <code className={sent.status === "SUCCESS" ? "ok" : "warn"}>
              {sent.status}
            </code>
          </div>
          {sendError && <p className="error">{sendError}</p>}
        </div>
      )}
    </div>
  );
}

interface ActivityRow {
  kind: "in" | "out";
  height: number;
  timestamp?: number;
  amount_mojos: string;
  coin_id: string;
  asset_kind: "xch" | "cat";
  asset_id?: string;
}

function ActivityTab({
  wallet,
  xchPrice,
}: {
  wallet: StoredWallet;
  xchPrice: number | null;
}) {
  const [snapshot, setSnapshot] = useState<CoinSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await getCoinSnapshot(wallet.fingerprint);
        if (!cancelled) setSnapshot(s);
      } catch {
        // best-effort
      }
    };
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [wallet.fingerprint]);

  const rows: ActivityRow[] = [];
  if (snapshot) {
    // XCH coin appearances + spends
    for (const c of Object.values(snapshot.coins)) {
      if (c.confirmed_block_index > 0) {
        rows.push({
          kind: "in",
          height: c.confirmed_block_index,
          timestamp: c.timestamp || undefined,
          amount_mojos: c.amount,
          coin_id: c.coin_id,
          asset_kind: "xch",
        });
      }
      if (c.spent && c.spent_block_index > 0) {
        rows.push({
          kind: "out",
          height: c.spent_block_index,
          amount_mojos: c.amount,
          coin_id: c.coin_id,
          asset_kind: "xch",
        });
      }
    }
    // CAT receipts + spends
    for (const cat of Object.values(snapshot.cats ?? {})) {
      for (const c of cat.coins) {
        if (c.confirmed_block_index > 0) {
          rows.push({
            kind: "in",
            height: c.confirmed_block_index,
            amount_mojos: c.amount,
            coin_id: c.coin_id,
            asset_kind: "cat",
            asset_id: cat.asset_id,
          });
        }
        if (c.spent && c.spent_block_index > 0) {
          rows.push({
            kind: "out",
            height: c.spent_block_index,
            amount_mojos: c.amount,
            coin_id: c.coin_id,
            asset_kind: "cat",
            asset_id: cat.asset_id,
          });
        }
      }
    }
  }
  rows.sort((a, b) => b.height - a.height);
  const metadata = snapshot?.cat_metadata ?? {};

  return (
    <div className="tab-body">
      {rows.length === 0 ? (
        <div className="empty-block">
          <p className="muted">
            No activity yet. Incoming and outgoing transactions appear here as
            they confirm on chain.
          </p>
        </div>
      ) : (
        <ul className="activity-list">
          {rows.slice(0, 200).map((r, i) => {
            const isIn = r.kind === "in";
            const meta =
              r.asset_id != null
                ? metadata[r.asset_id] ?? metadata[normalizeId(r.asset_id)]
                : null;
            const ticker = r.asset_kind === "xch" ? "XCH" : meta?.code ?? "CAT";
            const decimals = r.asset_kind === "xch" ? 12 : meta?.decimals ?? 3;
            const amt = formatAmount(r.amount_mojos, decimals);
            const usd =
              r.asset_kind === "xch" && xchPrice
                ? parseFloat(amt) * xchPrice
                : null;
            return (
              <li key={`${r.coin_id}-${r.kind}-${i}`} className="activity-row">
                <div className={isIn ? "activity-arrow ok" : "activity-arrow warn"}>
                  {isIn ? "↓" : "↑"}
                </div>
                <div className="activity-meta">
                  <div className="activity-title">
                    {isIn ? "Received" : "Sent"} {ticker}
                  </div>
                  <div className="muted small">block #{r.height.toLocaleString()}</div>
                </div>
                <div className="activity-amount">
                  <div className={isIn ? "ok" : "warn"}>
                    {isIn ? "+" : "−"}
                    {amt}
                  </div>
                  {usd != null && (
                    <div className="muted small">≈ ${formatUsd(usd)}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 200 && (
        <p className="muted small">Showing the most recent 200 events.</p>
      )}
    </div>
  );
}

function formatAmount(mojos: string, decimals: number): string {
  try {
    const m = BigInt(mojos);
    const scale = 10n ** BigInt(decimals);
    const whole = m / scale;
    const frac = m % scale;
    if (frac === 0n) return whole.toString();
    const fracStr = frac
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    return mojos;
  }
}

function normalizeId(id: string): string {
  return id.toLowerCase().replace(/^0x/, "");
}

function formatCatAmount(mojos: string, decimals: number): string {
  try {
    const m = BigInt(mojos);
    const scale = 10n ** BigInt(decimals);
    const whole = m / scale;
    const frac = m % scale;
    if (frac === 0n) return whole.toString();
    const fracStr = frac
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    return mojos;
  }
}

function pickNftImage(nft: NftView): string | null {
  const list = nft.metadata.data_uris ?? [];
  for (const u of list) {
    if (typeof u === "string" && u.length > 0) {
      // Replace ipfs:// with a public gateway
      if (u.startsWith("ipfs://")) {
        return `https://ipfs.io/ipfs/${u.slice("ipfs://".length)}`;
      }
      return u;
    }
  }
  return null;
}

function shortHash(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length <= 12) return hex;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

/**
 * CATs use 3 decimal places by convention (1 CAT = 1000 mojos). Render
 * with up to 3 decimals + trim trailing zeros.
 */
// CAT amounts are carried on-chain in the asset's smallest unit. The Chia CAT
// default is 3 decimals (1 CAT = 1000), but a token's Dexie metadata can
// declare a different precision — and the rest of the wallet (Home/Activity/
// Send) already honours `meta.decimals`. The approval dialog MUST use the same
// precision, otherwise the same coin reads e.g. "1 TOKEN" on Home but
// "1000 CAT" in the confirmation popup (the bug: amounts looked like raw mojos).
function mojosToCatUnits(mojos: string, decimals = 3): string {
  try {
    const m = BigInt(mojos);
    const scale = 10n ** BigInt(decimals);
    const whole = m / scale;
    const frac = m % scale;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${whole}.${fracStr}`;
  } catch {
    return mojos;
  }
}

function timeAgo(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function mojosToXch(mojos: string): string {
  // Mojos as decimal string → "X.XXXX" XCH. Simple impl using BigInt.
  try {
    const m = BigInt(mojos);
    const scale = 1_000_000_000_000n;
    const whole = m / scale;
    const frac = m % scale;
    const fracStr = frac.toString().padStart(12, "0").replace(/0+$/, "");
    const display = fracStr.length === 0 ? "0000" : fracStr.padEnd(4, "0");
    return `${whole}.${display}`;
  } catch {
    return mojos;
  }
}

/**
 * Human XCH amount with unit, trailing zeros trimmed: "1.5 XCH", "0.001 XCH".
 * Used by every approval summary so the user never has to count zeros in a
 * raw-mojos string. The exact mojo value still lives in the "Raw params" block.
 */
function fmtXch(mojos: string | number | bigint): string {
  try {
    const m = BigInt(String(mojos));
    const neg = m < 0n;
    const a = neg ? -m : m;
    const scale = 1_000_000_000_000n;
    const whole = a / scale;
    const frac = (a % scale).toString().padStart(12, "0").replace(/0+$/, "");
    const body = frac ? `${whole}.${frac}` : `${whole}`;
    return `${neg ? "-" : ""}${body} XCH`;
  } catch {
    return `${mojos} mojos`;
  }
}

/** Human CAT amount with unit (or a custom symbol): "1 CAT", "12.5 SBX". */
function fmtCat(mojos: string | number | bigint, symbol?: string, decimals = 3): string {
  return `${mojosToCatUnits(String(mojos), decimals)} ${symbol || "CAT"}`;
}

// Resolve a CAT asset_id to its display precision + symbol from the active
// wallet's Dexie metadata. Falls back to the Chia default (3 decimals, generic
// "CAT") for tokens the wallet doesn't track yet — never throws, never blocks
// the approval. The lookup mirrors the Home/Activity tabs (0x-prefixed and
// stripped forms both checked) so the same coin reads identically everywhere.
export interface CatDisplay {
  decimals: number;
  symbol?: string;
}
function resolveCatDisplay(
  assetId: string | null | undefined,
  meta: Record<string, DexieCatMetadata>,
): CatDisplay {
  if (!assetId) return { decimals: 3 };
  const m = meta[assetId] ?? meta[normalizeId(assetId)] ?? meta[`0x${normalizeId(assetId)}`];
  return { decimals: m?.decimals ?? 3, symbol: m?.code ?? undefined };
}

// Loads the active wallet's CAT metadata for the approval dialog. Empty until
// the snapshot resolves; an empty map just means every CAT renders with the
// safe 3-decimal / "CAT" default (current behaviour), so the dialog is never
// blocked waiting on metadata.
function useApprovalCatMeta(fingerprint: number | null): Record<string, DexieCatMetadata> {
  const [meta, setMeta] = useState<Record<string, DexieCatMetadata>>({});
  useEffect(() => {
    if (fingerprint == null) return;
    let cancelled = false;
    void (async () => {
      try {
        const snap = await getCoinSnapshot(fingerprint);
        if (!cancelled) setMeta(snap.cat_metadata ?? {});
      } catch {
        /* leave empty — formatters fall back to 3 decimals / "CAT" */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fingerprint]);
  return meta;
}

type SendAssetKind = "xch" | "cat";

function SendTab({ wallet, balance }: { wallet: StoredWallet; balance: BalanceInfo | null }) {
  const [snapshot, setSnapshot] = useState<CoinSnapshot | null>(null);
  const [assetKey, setAssetKey] = useState<string>("xch");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee] = useState("0");
  const [addressValid, setAddressValid] = useState<boolean | null>(null);
  const [addressInfo, setAddressInfo] = useState<{ puzzle_hash: string; prefix: string } | null>(
    null,
  );
  const [validating, setValidating] = useState(false);
  const [sending, setSending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sent, setSent] = useState<SendXchResult | null>(null);
  // Tracks which chip ("to" | "tx") flashed "copied" after a click — null when
  // nothing was recently copied. Auto-clears after the 1.2s feedback timeout.
  const [copied, setCopied] = useState<string | null>(null);

  // Pull the latest local coin snapshot so we can pick a coin to spend.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const s = await getCoinSnapshot(wallet.fingerprint);
        if (!cancelled) setSnapshot(s);
      } catch {
        // best-effort
      }
    };
    void refresh();
    const id = setInterval(refresh, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [wallet.fingerprint]);

  const cats = snapshot?.cats ? Object.values(snapshot.cats) : [];
  const catsWithBalance = cats.filter((c) => c.unspent_coin_count > 0);
  const metadata = snapshot?.cat_metadata ?? {};

  // Selected asset details
  const selectedAsset: {
    kind: SendAssetKind;
    asset_id?: string;
    ticker: string;
    name: string;
    decimals: number;
    available_mojos: bigint;
    coin_count: number;
    icon_url?: string;
  } = assetKey === "xch"
    ? {
        kind: "xch",
        ticker: "XCH",
        name: "Chia",
        decimals: 12,
        // Use the local coin-store snapshot — same source the Home tab uses.
        // The old `get_address_balance` (`balance.total_unspent_xch`) only sees
        // the primary address and MISSES coins on other derived / hardened PHs,
        // so a wallet with XCH on a non-primary address showed "Available: 0"
        // here and couldn't send despite Home showing the balance.
        available_mojos: BigInt(snapshot?.unspent_mojos ?? "0"),
        coin_count: snapshot?.unspent_count ?? balance?.unspent_coin_count ?? 0,
      }
    : (() => {
        const cat = catsWithBalance.find((c) => c.asset_id === assetKey);
        const meta = cat ? metadata[cat.asset_id] ?? metadata[normalizeId(cat.asset_id)] : null;
        return {
          kind: "cat" as const,
          asset_id: assetKey,
          ticker: meta?.code ?? "CAT",
          name: meta?.name ?? shortHash(assetKey),
          decimals: meta?.decimals ?? 3,
          available_mojos: cat ? BigInt(cat.total_unspent_mojos) : 0n,
          coin_count: cat?.unspent_coin_count ?? 0,
          icon_url: meta?.image_url,
        };
      })();

  useEffect(() => {
    if (!to.trim()) {
      setAddressValid(null);
      setAddressInfo(null);
      return;
    }
    let cancelled = false;
    setValidating(true);
    const t = setTimeout(async () => {
      try {
        const res = await callEngine<
          { valid: boolean; puzzle_hash?: string; prefix?: string; error?: string }
        >("check_address", { address: to.trim() });
        if (!cancelled) {
          if (res.valid && res.puzzle_hash && res.prefix) {
            setAddressValid(true);
            setAddressInfo({ puzzle_hash: res.puzzle_hash, prefix: res.prefix });
          } else {
            setAddressValid(false);
            setAddressInfo(null);
          }
        }
      } catch {
        if (!cancelled) {
          setAddressValid(false);
          setAddressInfo(null);
        }
      } finally {
        if (!cancelled) setValidating(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [to]);

  const amountNum = parseFloat(amount || "0");
  const feeNum = parseFloat(fee || "0");
  // amountMojos uses the SELECTED asset's decimals; fee is always XCH (12).
  const amountMojos = scaleAmount(amountNum, selectedAsset.decimals);
  const feeMojos = scaleAmount(feeNum, 12);
  // CAT fee is paid in XCH — check it against the same coin-store snapshot the
  // XCH path uses, not the primary-address-only `balance` (which misses coins).
  const xchAvailMojos = BigInt(snapshot?.unspent_mojos ?? "0");
  const haveEnough =
    selectedAsset.kind === "xch"
      ? selectedAsset.available_mojos >= amountMojos + feeMojos
      : selectedAsset.available_mojos >= amountMojos && xchAvailMojos >= feeMojos;
  const canSend = addressValid && amountNum > 0 && haveEnough && !sending;

  const send = async () => {
    setSending(true);
    setSubmitError(null);
    setSent(null);
    try {
      // Two derivation maps: unhardened from `derive_addresses` (live), and
      // hardened from the cached `store.hardened_phs` (populated once after
      // unlock). When picking inputs we check both; coins whose puzzle hash
      // sits in the hardened set must travel to the engine with
      // `derivation_kind: "hardened"` so the engine signs with
      // master_to_wallet_hardened instead of unhardened — without that the
      // signature won't verify against the coin's locked puzzle.
      //
      // Match coin-sync's 200-address window for unhardened. With only 50
      // we'd miss coins that live at index 50–199 in wallets that have
      // cycled through many receive addresses.
      const derived = await callEngine<{
        addresses: { index: number; puzzle_hash: string }[];
      }>("derive_addresses", {
        fingerprint: wallet.fingerprint,
        start: 0,
        count: 200,
        testnet: false,
      });
      const unhardenedPhToIndex: Record<string, number> = {};
      for (const a of derived.addresses) {
        unhardenedPhToIndex[a.puzzle_hash] = a.index;
      }
      const fresh = await getCoinSnapshot(wallet.fingerprint);
      const hardenedPhToIndex: Record<string, number> = {};
      for (const [ph, idx] of Object.entries(fresh.hardened_phs ?? {})) {
        // Cache stores both 0x-prefixed and stripped forms historically;
        // normalise to one shape we can look up consistently.
        hardenedPhToIndex[ph.startsWith("0x") ? ph : `0x${ph}`] = idx;
      }
      // Returns { index, kind } if we own the ph at either path, else null.
      const lookupPh = (
        ph: string,
      ): { index: number; kind: "hardened" | "unhardened" } | null => {
        const with0x = ph.startsWith("0x") ? ph : `0x${ph}`;
        const without0x = ph.startsWith("0x") ? ph.slice(2) : ph;
        const u =
          unhardenedPhToIndex[with0x] ?? unhardenedPhToIndex[without0x];
        if (u !== undefined) return { index: u, kind: "unhardened" };
        const h =
          hardenedPhToIndex[with0x] ?? hardenedPhToIndex[without0x];
        if (h !== undefined) return { index: h, kind: "hardened" };
        return null;
      };

      if (selectedAsset.kind === "xch") {
        // pickCoinsForSendMulti only knows unhardened; pick by hand to
        // include hardened too. Largest-first, like the helper.
        const candidates = Object.values(fresh.coins)
          .filter((c) => !c.spent)
          .map((c) => ({ coin: c, owner: lookupPh(c.puzzle_hash) }))
          .filter((x) => x.owner !== null)
          .sort((a, b) =>
            BigInt(b.coin.amount) > BigInt(a.coin.amount) ? 1 : -1,
          );
        let running = 0n;
        const picked: Array<{
          coin_id: string;
          parent_coin_info: string;
          puzzle_hash: string;
          amount: string;
          derivation_index: number;
          derivation_kind?: "hardened" | "unhardened";
        }> = [];
        for (const { coin, owner } of candidates) {
          if (running >= amountMojos + feeMojos) break;
          picked.push({
            coin_id: coin.coin_id,
            parent_coin_info: coin.parent_coin_info,
            puzzle_hash: coin.puzzle_hash,
            amount: coin.amount,
            derivation_index: owner!.index,
            ...(owner!.kind === "hardened" ? { derivation_kind: "hardened" } : {}),
          });
          running += BigInt(coin.amount);
        }
        if (running < amountMojos + feeMojos) {
          setSubmitError("Wallet balance changed. Refresh and try again.");
          return;
        }
        const result = await callEngine<SendXchResult>("send_xch", {
          fingerprint: wallet.fingerprint,
          recipient_address: to.trim(),
          amount_mojos: amountMojos.toString(),
          fee_mojos: feeMojos.toString(),
          input_coins: picked,
          change_index: picked[0]!.derivation_index,
          ...(picked[0]!.derivation_kind === "hardened"
            ? { change_kind: "hardened" }
            : {}),
          testnet: false,
          broadcast: true,
        });
        setSent(result);
        if (result.error) setSubmitError(result.error);
      } else {
        const catAsset = fresh.cats?.[selectedAsset.asset_id!];
        if (!catAsset) {
          setSubmitError("CAT no longer detected in wallet — refresh and try again.");
          return;
        }
        const sortedCoins = catAsset.coins
          .filter((c) => !c.spent)
          .map((c) => ({ coin: c, owner: lookupPh(c.inner_puzzle_hash) }))
          .filter((x) => x.owner !== null)
          .sort((a, b) => (BigInt(b.coin.amount) > BigInt(a.coin.amount) ? 1 : -1));
        let running = 0n;
        const picked: Array<{
          parent_coin_info: string;
          puzzle_hash: string;
          amount: string;
          inner_puzzle_hash: string;
          derivation_index: number;
          derivation_kind?: "hardened" | "unhardened";
          lineage_proof: {
            parent_name: string;
            inner_puzzle_hash: string;
            amount: string;
          };
        }> = [];
        for (const { coin, owner } of sortedCoins) {
          if (running >= amountMojos) break;
          picked.push({
            parent_coin_info: coin.parent_coin_info,
            puzzle_hash: coin.puzzle_hash,
            amount: coin.amount,
            inner_puzzle_hash: coin.inner_puzzle_hash,
            derivation_index: owner!.index,
            ...(owner!.kind === "hardened" ? { derivation_kind: "hardened" } : {}),
            lineage_proof: coin.lineage_proof,
          });
          running += BigInt(coin.amount);
        }
        if (running < amountMojos) {
          setSubmitError("Not enough CAT coins to cover the amount.");
          return;
        }
        const result = await callEngine<SendXchResult>("send_cat", {
          fingerprint: wallet.fingerprint,
          asset_id: selectedAsset.asset_id,
          recipient_address: to.trim(),
          amount_mojos: amountMojos.toString(),
          fee_mojos: feeMojos.toString(),
          input_coins: picked,
          change_index: picked[0]!.derivation_index,
          ...(picked[0]!.derivation_kind === "hardened"
            ? { change_kind: "hardened" }
            : {}),
          broadcast: true,
        });
        setSent(result);
        if (result.error) setSubmitError(result.error);
      }
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const formattedAvailable = formatAmount(
    selectedAsset.available_mojos.toString(),
    selectedAsset.decimals,
  );

  const resetForm = () => {
    setTo("");
    setAmount("");
    setFee("0");
    setSent(null);
    setSubmitError(null);
    setAddressValid(null);
    setAddressInfo(null);
  };

  // After a successful submit replace the form with a clean confirmation
  // screen — minimal hero layout, no nested cards. Form state (to/amount/fee)
  // is still in scope so we can show what the user just sent without
  // buffering it into a separate "lastSent".
  if (sent) {
    const sentOk = sent.status === "SUCCESS";
    const txIdHex = sent.tx_id.startsWith("0x") ? sent.tx_id : `0x${sent.tx_id}`;
    const explorerUrl = `https://www.spacescan.io/tx/${txIdHex}`;
    const copy = (text: string, key: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(key);
          setTimeout(() => setCopied(null), 1200);
        })
        .catch(() => {
          // clipboard may be denied; silent — the title attr has the full value
        });
    };
    return (
      <div className="tab-body send-success">
        <div className="send-success-hero">
          <span className={`send-success-badge ${sentOk ? "ok" : "warn"}`} aria-hidden="true">
            {sentOk ? (
              <svg viewBox="0 0 24 24" fill="none">
                <path
                  d="M5 12.5l4.5 4.5L19 7.5"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M12 7v6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx="12" cy="17" r="1.25" fill="currentColor" />
              </svg>
            )}
          </span>
          <span className="send-success-eyebrow">{sentOk ? "Sent" : "Submitted"}</span>
        </div>

        <div className="send-success-amount">
          <span className="send-success-amount-num">{amount}</span>
          <span className="send-success-amount-ticker">{selectedAsset.ticker}</span>
        </div>

        <div className="send-success-lines">
          <button
            type="button"
            className="send-success-line"
            onClick={() => copy(to.trim(), "to")}
            title={`Copy ${to.trim()}`}
          >
            <span className="send-success-line-label">to</span>
            <span className="send-success-line-chip">{shortHash(to.trim())}</span>
            {copied === "to" && <span className="send-success-line-copied">copied</span>}
          </button>
          <button
            type="button"
            className="send-success-line"
            onClick={() => copy(sent.tx_id, "tx")}
            title={`Copy ${sent.tx_id}`}
          >
            <span className="send-success-line-label">tx</span>
            <span className="send-success-line-chip">{shortHash(sent.tx_id)}</span>
            {copied === "tx" && <span className="send-success-line-copied">copied</span>}
          </button>
          <div className="send-success-line static">
            <span className="send-success-line-label">status</span>
            <span className={`send-success-line-chip ${sentOk ? "ok" : "warn"}`}>{sent.status}</span>
          </div>
          {BigInt(sent.change_mojos ?? "0") > 0n && (
            <div className="send-success-line static">
              <span className="send-success-line-label">change</span>
              <span className="send-success-line-chip">{mojosToXch(sent.change_mojos)} XCH</span>
            </div>
          )}
        </div>

        <div className="send-success-actions">
          <button onClick={resetForm}>Send another</button>
          <a
            className="send-success-link"
            href={explorerUrl}
            target="_blank"
            rel="noreferrer"
          >
            View on explorer ↗
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-body">
      <label className="field">
        <span>Asset</span>
        <select
          value={assetKey}
          onChange={(e) => {
            setAssetKey(e.target.value);
            setAmount("");
            setSent(null);
            setSubmitError(null);
          }}
        >
          <option value="xch">XCH — Chia</option>
          {catsWithBalance.map((c) => {
            const meta = metadata[c.asset_id] ?? metadata[normalizeId(c.asset_id)];
            return (
              <option key={c.asset_id} value={c.asset_id}>
                {meta?.code ? `${meta.code} — ` : ""}
                {meta?.name ?? shortHash(c.asset_id)}
              </option>
            );
          })}
        </select>
        <span className="muted small">
          Available: {formattedAvailable} {selectedAsset.ticker}
          {selectedAsset.coin_count > 0 && ` · ${selectedAsset.coin_count} coins`}
        </span>
      </label>

      <label className="field">
        <span>Recipient address</span>
        <input
          type="text"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="xch1..."
          spellCheck={false}
        />
        {validating && <span className="muted small">validating…</span>}
        {addressValid === true && addressInfo && (
          <span className="small ok">✓ valid {addressInfo.prefix} address</span>
        )}
        {addressValid === false && <span className="small error">invalid bech32m</span>}
      </label>

      <label className="field">
        <span className="field-label-row">
          Amount ({selectedAsset.ticker})
          {selectedAsset.available_mojos > 0n && (
            <button
              type="button"
              className="field-max"
              onClick={() => {
                // XCH must leave room for the fee; CATs pay the fee in XCH so
                // the whole CAT balance is spendable.
                const max =
                  selectedAsset.kind === "xch"
                    ? selectedAsset.available_mojos - feeMojos
                    : selectedAsset.available_mojos;
                setAmount(formatAmount((max > 0n ? max : 0n).toString(), selectedAsset.decimals));
              }}
            >
              Max
            </button>
          )}
        </span>
        <input
          type="number"
          step="0.0001"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.0"
        />
        {amountNum > 0 && !haveEnough && (
          <span className="small error">
            insufficient: have {formattedAvailable} {selectedAsset.ticker}
          </span>
        )}
      </label>

      <label className="field">
        <span>Fee (XCH)</span>
        <input
          type="number"
          step="0.0001"
          min="0"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
        />
      </label>

      <button disabled={!canSend} onClick={() => void send()}>
        {sending ? "Sending…" : `Send ${selectedAsset.ticker}`}
      </button>

      {submitError && <p className="error">{submitError}</p>}
    </div>
  );
}

function scaleAmount(n: number, decimals: number): bigint {
  if (!isFinite(n) || n <= 0) return 0n;
  const s = n.toFixed(decimals);
  // Split int and fractional parts so we never lose precision via Math.round
  const [whole = "0", frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(fracPadded || "0");
}

// XCH decimal string → mojos string, BigInt-safe (no float round-trip). Used
// by the approval fee-override so the canonical fee stays exact. Malformed
// input collapses to "0" rather than throwing — the worst case is a 0 fee,
// never a wrong large one.
function xchToMojosStr(xch: string): string {
  const t = (xch ?? "").trim();
  if (t === "" || t === ".") return "0";
  const neg = t.startsWith("-");
  const [whole = "0", frac = ""] = t.replace(/^-/, "").split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return "0";
  const fracPadded = (frac + "000000000000").slice(0, 12);
  const mojos = BigInt(whole || "0") * 1_000_000_000_000n + BigInt(fracPadded || "0");
  return (neg ? -mojos : mojos).toString();
}

interface DerivedAddress {
  index: number;
  address: string;
  puzzle_hash: string;
  public_key: string;
}

function ReceiveTab({ wallet }: { wallet: StoredWallet }) {
  const [addresses, setAddresses] = useState<DerivedAddress[]>([]);
  const [active, setActive] = useState<number>(0);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [editingLabel, setEditingLabel] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load persisted state + derive a chunk of addresses
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const state = await getDerivationState(wallet.fingerprint);
      if (cancelled) return;
      setActive(state.activeIndex);
      setLabels(state.labels);
      try {
        // Derive enough to cover the selected index + reasonable browsing range
        const count = Math.max(20, state.activeIndex + 10);
        const res = await callEngine<{ addresses: DerivedAddress[] }>("derive_addresses", {
          fingerprint: wallet.fingerprint,
          start: 0,
          count,
          testnet: false,
        });
        if (!cancelled) setAddresses(res.addresses);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.fingerprint]);

  const activeAddr = addresses.find((a) => a.index === active) ?? addresses[0];

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard may be denied
    }
  };

  const nextAddress = async () => {
    const next = (activeAddr?.index ?? -1) + 1;
    // ensure we have it derived
    if (next >= addresses.length) {
      try {
        const res = await callEngine<{ addresses: DerivedAddress[] }>("derive_addresses", {
          fingerprint: wallet.fingerprint,
          start: addresses.length,
          count: 10,
          testnet: false,
        });
        setAddresses([...addresses, ...res.addresses]);
      } catch (err) {
        setError((err as Error).message);
        return;
      }
    }
    setActive(next);
    await setActiveIndex(wallet.fingerprint, next);
  };

  const pickAddress = async (idx: number) => {
    setActive(idx);
    await setActiveIndex(wallet.fingerprint, idx);
    setShowAll(false);
  };

  const startEditLabel = () => {
    setEditingLabel(labels[String(active)] ?? "");
    setEditing(true);
  };

  const saveEditLabel = async () => {
    await setLabel(wallet.fingerprint, active, editingLabel);
    const nextLabels = { ...labels };
    if (editingLabel.trim()) nextLabels[String(active)] = editingLabel.trim();
    else delete nextLabels[String(active)];
    setLabels(nextLabels);
    setEditing(false);
  };

  if (!activeAddr) {
    return (
      <div className="tab-body">
        {error ? <p className="error">{error}</p> : <p className="muted">Deriving…</p>}
      </div>
    );
  }

  const currentLabel = labels[String(active)];

  if (showAll) {
    return (
      <div className="tab-body">
        <div className="receive-list-header">
          <button className="ghost" onClick={() => setShowAll(false)}>
            ← Back
          </button>
          <h3>Your addresses</h3>
        </div>
        <ul className="address-list">
          {addresses.map((a) => {
            const lbl = labels[String(a.index)];
            return (
              <li
                key={a.index}
                className={a.index === active ? "active" : ""}
                onClick={() => void pickAddress(a.index)}
                style={{ cursor: "pointer" }}
              >
                <span className="address-index">#{a.index}</span>
                <div className="address-block">
                  {lbl && <div className="address-label">{lbl}</div>}
                  <code>{a.address}</code>
                </div>
                <span className="small ok">{a.index === active ? "✓" : ""}</span>
              </li>
            );
          })}
        </ul>
        <button className="secondary" onClick={() => void nextAddress()}>
          Generate next address
        </button>
      </div>
    );
  }

  return (
    <div className="tab-body">
      <div className="receive-card">
        <div className="receive-card-header">
          <div>
            {currentLabel && !editing ? (
              <div className="address-label" onClick={startEditLabel} style={{ cursor: "pointer" }}>
                {currentLabel} <span className="muted small">edit</span>
              </div>
            ) : !editing ? (
              <button className="ghost" onClick={startEditLabel}>
                + add label
              </button>
            ) : null}
            {editing && (
              <div className="row">
                <input
                  type="text"
                  value={editingLabel}
                  autoFocus
                  placeholder="Label (e.g. Exchange)"
                  onChange={(e) => setEditingLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveEditLabel();
                    if (e.key === "Escape") setEditing(false);
                  }}
                />
                <button onClick={() => void saveEditLabel()}>OK</button>
              </div>
            )}
          </div>
          <span className="address-index">#{active}</span>
        </div>

        <div className="qr-wrap">
          <Qr data={activeAddr.address} size={196} />
        </div>

        <code className="receive-address">{activeAddr.address}</code>

        <div className="row">
          <button onClick={() => void copy(activeAddr.address)}>
            {copied ? "Copied ✓" : "Copy address"}
          </button>
          <button className="secondary" onClick={() => void nextAddress()}>
            New address
          </button>
        </div>
        <button className="ghost" onClick={() => setShowAll(true)}>
          See all derived addresses
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function DevTab({ wallet }: { wallet: StoredWallet }) {
  const [signMessage, setSignMessage] = useState<string>("hello world");
  const [signature, setSignature] = useState<string | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  const [decodeInput, setDecodeInput] = useState<string>("");
  const [decoded, setDecoded] = useState<{ puzzle_hash: string; prefix: string } | null>(null);
  const [decodeError, setDecodeError] = useState<string | null>(null);

  const onSign = async () => {
    setSigning(true);
    setSignature(null);
    setSignError(null);
    try {
      const messageHex = toHex(signMessage);
      const res = await callEngine<{ signature: string }>("sign_message", {
        fingerprint: wallet.fingerprint,
        index: 0,
        message: messageHex,
      });
      setSignature(res.signature);
    } catch (err) {
      setSignError((err as Error).message);
    } finally {
      setSigning(false);
    }
  };

  const onDecode = async () => {
    setDecoded(null);
    setDecodeError(null);
    try {
      const res = await callEngine<{ puzzle_hash: string; prefix: string }>("decode_address", {
        address: decodeInput.trim(),
      });
      setDecoded(res);
    } catch (err) {
      setDecodeError((err as Error).message);
    }
  };

  return (
    <div className="tab-body">
      <h3>Sign message</h3>
      <input
        type="text"
        value={signMessage}
        onChange={(e) => setSignMessage(e.target.value)}
      />
      <button onClick={onSign} disabled={signing || !signMessage}>
        {signing ? "Signing…" : "Sign with index 0"}
      </button>
      {signature && (
        <div className="result">
          <div>
            <span className="muted">signature</span>
            <code>{signature}</code>
          </div>
        </div>
      )}
      {signError && <p className="error">{signError}</p>}

      <h3>Decode address</h3>
      <input
        type="text"
        value={decodeInput}
        onChange={(e) => setDecodeInput(e.target.value)}
        placeholder="xch1…"
      />
      <button onClick={onDecode} disabled={!decodeInput.trim()}>
        Decode
      </button>
      {decoded && (
        <div className="result">
          <div>
            <span className="muted">prefix</span>
            <code>{decoded.prefix}</code>
          </div>
          <div>
            <span className="muted">puzzle hash</span>
            <code>{decoded.puzzle_hash}</code>
          </div>
        </div>
      )}
      {decodeError && <p className="error">{decodeError}</p>}
    </div>
  );
}

function toHex(str: string): string {
  const bytes = new TextEncoder().encode(str);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

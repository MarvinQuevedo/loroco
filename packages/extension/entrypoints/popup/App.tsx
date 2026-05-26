import { useEffect, useState } from "react";
import {
  cacheHardenedPhs,
  callEngine,
  decideApproval,
  forceCoinSync,
  getCoinSnapshot,
  getCoinSyncTelemetry,
  getSidecarSettings,
  getSyncState,
  getXchPriceUsd,
  listConnections,
  listPendingApprovals,
  pickCoinsForSendMulti,
  probeSidecar,
  revokeConnection,
  setActiveWallet,
  setSidecarSettings,
  type CoinSnapshot,
  type CoinSyncTelemetry,
  type ConnectionRecord,
  type DexieCatMetadata,
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

type TabName = "home" | "send" | "receive" | "nfts" | "activity" | "dev" | "settings";

const VALID_TABS: readonly TabName[] = [
  "home",
  "send",
  "receive",
  "nfts",
  "activity",
  "dev",
  "settings",
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

  // Adaptive toolbar icon — Chrome doesn't auto-swap manifest icons by
  // OS theme. The popup is the only place we can call matchMedia, so we
  // detect the theme here (every time the popup opens) and tell the SW
  // which icon set to use. White silhouette for dark Chrome, black for
  // light Chrome. The CSS in styles.css handles the same swap for
  // in-popup logos via `filter: invert(1)`.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (dark: boolean) => {
      const dir = dark ? "icon" : "icon-light";
      try {
        chrome.action.setIcon({
          path: {
            16: `${dir}/16.png`,
            32: `${dir}/32.png`,
            48: `${dir}/48.png`,
            128: `${dir}/128.png`,
          },
        });
      } catch {
        // ignore — older Chromes or denied paths
      }
    };
    apply(mq.matches);
    const handler = (e: MediaQueryListEvent) => apply(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
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

  const decide = async (id: string, approved: boolean) => {
    try {
      await decideApproval(id, approved);
    } finally {
      setPending((p) => p.filter((r) => r.id !== id));
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
  // the user was on and shows the inline approval screen. This is the
  // MetaMask UX: clicking the extension icon (or auto-open from the SW)
  // surfaces the pending request immediately. The body returns to the
  // previous tab once every queued request is decided.
  const showApproval = pending.length > 0 && view.kind === "home";

  return (
    <div className="ozone-popup">
      <header className="ozone-header">
        <span className="ozone-logo">
          <img src="/icon/48.png" alt="" className="ozone-logo-mark" />
          Loroco
        </span>
        {view.kind === "home" && !showApproval && (
          <HeaderWalletChip
            wallet={view.wallet}
            wallets={view.wallets}
            onSwitchWallet={switchWallet}
            onAddWallet={startAddWallet}
          />
        )}
        {view.kind === "home" && !showApproval && (
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
          </div>
        )}
        {showApproval && (
          <span className="ozone-meta">
            {pending.length > 1 ? `${pending.length} pending` : pending[0]!.method}
          </span>
        )}
      </header>
      <main>
        {showApproval && (
          <ApprovalScreen request={pending[0]!} queueSize={pending.length} onDecide={decide} />
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

function ApprovalScreen({
  request,
  queueSize,
  onDecide,
}: {
  request: PendingApproval;
  queueSize: number;
  onDecide: (id: string, approved: boolean) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const decide = async (approved: boolean) => {
    if (busy) return;
    setBusy(approved ? "approve" : "reject");
    try {
      await onDecide(request.id, approved);
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

      <ApprovalSummary request={request} />

      <details>
        <summary>Raw params</summary>
        <pre className="params-raw">{JSON.stringify(request.params, null, 2)}</pre>
      </details>

      <div className="row">
        <button
          className="secondary"
          disabled={busy !== null}
          onClick={() => void decide(false)}
        >
          {busy === "reject" ? "…" : "Reject"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => void decide(true)}
        >
          {busy === "approve" ? "…" : "Approve"}
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
    default:
      return method;
  }
}

interface DecodedOfferLite {
  offered: { xch_mojos: string; cats: Array<{ asset_id: string; amount: string }>; nft_launcher_ids: string[] };
  requested: { xch_mojos: string; cats: Array<{ asset_id: string; amount: string }>; nft_launcher_ids: string[] };
  offered_royalties: Array<{ nft_launcher_id: string; royalty_basis_points: number }>;
}

function TakeOfferSummary({ offer }: { offer: string }) {
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
    return <p className="error small">Could not decode offer: {error}</p>;
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
        <OfferAssetList side={decoded.offered} />
      </div>
      <div className="offer-arrow" aria-hidden>↕</div>
      <div className="offer-side offer-pay">
        <span className="muted small">You pay</span>
        <OfferAssetList side={decoded.requested} />
      </div>
      {decoded.offered_royalties.length > 0 && (
        <p className="muted small">
          Royalties:{" "}
          {decoded.offered_royalties
            .map((r) => `${(r.royalty_basis_points / 100).toFixed(2)}%`)
            .join(", ")}{" "}
          go to the original NFT creator.
        </p>
      )}
    </div>
  );
}

function OfferAssetList({
  side,
}: {
  side: DecodedOfferLite["offered"];
}) {
  const xch = BigInt(side.xch_mojos);
  const items: string[] = [];
  if (xch > 0n) {
    items.push(`${mojosToXch(xch.toString())} XCH`);
  }
  for (const c of side.cats) {
    items.push(`${c.amount} ${shortHash(c.asset_id)}`);
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

function ApprovalSummary({ request }: { request: PendingApproval }) {
  const params = request.params as Record<string, unknown> | null;

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
                Stay connected until you remove it from{" "}
                <strong>Settings → Connected sites</strong>
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
      const to = params?.to;
      const amount = params?.amount;
      const assetId = params?.assetId;
      const fee = params?.fee;
      return (
        <div className="result">
          <div>
            <span className="muted">to</span>
            <code>{String(to ?? "")}</code>
          </div>
          <div>
            <span className="muted">amount</span>
            <code>{String(amount ?? "")}</code>
          </div>
          <div>
            <span className="muted">asset id</span>
            <code>{String(assetId ?? "(XCH)")}</code>
          </div>
          {fee != null && (
            <div>
              <span className="muted">fee</span>
              <code>{String(fee)}</code>
            </div>
          )}
        </div>
      );
    }

    case "takeOffer": {
      const offer = typeof params?.offer === "string" ? (params.offer as string) : "";
      const fee = params?.fee;
      return (
        <>
          {offer ? <TakeOfferSummary offer={offer} /> : null}
          {fee != null && BigInt(String(fee)) > 0n && (
            <div className="result">
              <div>
                <span className="muted">fee</span>
                <code>{String(fee)}</code>
              </div>
            </div>
          )}
        </>
      );
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
      const sb = params?.spendBundle as { coin_spends?: unknown[] } | undefined;
      const spendCount = Array.isArray(sb?.coin_spends) ? sb!.coin_spends.length : 0;
      return (
        <div className="result">
          <p className="muted small">
            This site asks the wallet to broadcast a pre-built spend bundle to
            the network. You will sign nothing — but you will publish it.
          </p>
          <div>
            <span className="muted">coin spends</span>
            <code>{spendCount}</code>
          </div>
        </div>
      );
    }

    case "signCoinSpends": {
      const cs = (params?.coinSpends as unknown[] | undefined) ?? [];
      return (
        <div className="result">
          <p className="muted small">
            This site asks the wallet to sign {cs.length} coin spend
            {cs.length === 1 ? "" : "s"}. Signing means the spends become
            broadcastable — only approve if you trust the site.
          </p>
        </div>
      );
    }

    case "createOffer": {
      const offerAssets = (params?.offerAssets as Array<{ assetId: string; amount: string }> | undefined) ?? [];
      const requestAssets = (params?.requestAssets as Array<{ assetId: string; amount: string }> | undefined) ?? [];
      const fee = params?.fee;
      return (
        <div className="offer-summary">
          <div className="offer-side offer-pay">
            <span className="muted small">You will offer</span>
            <ul className="offer-asset-list">
              {offerAssets.length === 0 ? (
                <li className="muted small">nothing</li>
              ) : (
                offerAssets.map((a, i) => (
                  <li key={i}>
                    {a.amount} {a.assetId === "" ? "XCH" : shortHash(a.assetId)}
                  </li>
                ))
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
                requestAssets.map((a, i) => (
                  <li key={i}>
                    {a.amount} {a.assetId === "" ? "XCH" : shortHash(a.assetId)}
                  </li>
                ))
              )}
            </ul>
          </div>
          {fee != null && BigInt(String(fee)) > 0n && (
            <p className="muted small">Fee: {String(fee)} mojos</p>
          )}
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
              <span className="muted">fee</span>
              <code>{String(fee)}</code>
            </div>
          )}
        </div>
      );
    }

    default:
      return null;
  }
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
        <img src="/icon/128.png" alt="" className="screen-logo" />
        <h1>Welcome to Loroco</h1>
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingForget, setConfirmingForget] = useState(false);

  const forget = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeWallet(wallet.fingerprint);
      // Pick another wallet if there's one left; otherwise the parent will
      // route back to onboarding next render.
      const remaining = wallets.filter((w) => w.fingerprint !== wallet.fingerprint);
      if (remaining.length > 0) {
        await onSwitchWallet(remaining[0]!.fingerprint);
      } else {
        // No more wallets — clear active state so the popup re-renders into
        // the onboarding screen on the next read.
        await chrome.storage.session.remove("activeFingerprint");
        await chrome.runtime.sendMessage({
          from: "popup",
          kind: "set-active-wallet",
          walletId: null,
        });
        // Hard reload so the parent re-fetches the wallet list (which is
        // now empty) and routes to onboarding.
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
      // Backfill master_public_key for wallets imported before we tracked it.
      const w = !wallet.masterPublicKey && res.master_public_key
        ? { ...wallet, masterPublicKey: res.master_public_key }
        : wallet;
      if (w !== wallet) await saveWallet(w);
      // Derive + cache hardened PHs while the wallet is unlocked. The sync
      // loop reuses them across SW restarts; without this call we'd miss
      // every receive on a hardened address (Sage's default path).
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

  return (
    <section className="screen">
      <img src="/icon/128.png" alt="" className="screen-logo" />
      <h1>Unlock</h1>
      {wallets.length > 1 ? (
        <label className="field">
          <span>Wallet</span>
          <select
            value={wallet.fingerprint}
            onChange={(e) => void onSwitchWallet(Number(e.target.value))}
          >
            {wallets.map((w) => (
              <option key={w.fingerprint} value={w.fingerprint}>
                {w.label === `Wallet ${w.fingerprint}`
                  ? ` ${w.fingerprint}`
                  : `${w.label} ·  ${w.fingerprint}`}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="muted">{wallet.label}</p>
      )}
      <label className="field">
        <span>Password</span>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy && password) void unlock();
          }}
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button onClick={unlock} disabled={busy || !password}>
        {busy ? "Unlocking…" : "Unlock"}
      </button>

      <div className="lock-forget">
        {!confirmingForget && (
          <button
            type="button"
            className="link-button"
            onClick={() => setConfirmingForget(true)}
            disabled={busy}
          >
            Forgot password? Remove this wallet
          </button>
        )}
        {confirmingForget && (
          <>
            <p className="muted small">
              This deletes the encrypted seed for{" "}
              <strong>{wallet.label === `Wallet ${wallet.fingerprint}` ? ` ${wallet.fingerprint}` : wallet.label}</strong>{" "}
              from this browser. Make sure you have your recovery phrase before continuing.
            </p>
            <div className="row">
              <button
                type="button"
                className="secondary"
                onClick={() => setConfirmingForget(false)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void forget()}
                disabled={busy}
              >
                {busy ? "Removing…" : "Remove wallet"}
              </button>
            </div>
          </>
        )}
      </div>
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
  // it themselves (Settings has its own scrollable surface).
  const showBalanceBar = tab !== "settings";

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
            sync={sync}
            onLock={onLock}
            onSwitchWallet={onSwitchWallet}
            onAddWallet={onAddWallet}
          />
        )}
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

function SettingsTab({
  wallet,
  wallets,
  sync,
  onLock,
  onSwitchWallet,
  onAddWallet,
}: {
  wallet: StoredWallet;
  wallets: StoredWallet[];
  sync: SyncState | null;
  onLock: () => void | Promise<void>;
  onSwitchWallet: (fp: number) => void | Promise<void>;
  onAddWallet: () => void;
}) {
  const [revealing, setRevealing] = useState(false);
  const [revealPwd, setRevealPwd] = useState("");
  const [revealedMnemonic, setRevealedMnemonic] = useState<string | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [copiedFingerprint, setCopiedFingerprint] = useState(false);

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
      </div>

      <h3>Local peer sync</h3>
      <LocalPeerSyncSection />

      <h3>Sync details</h3>
      <SyncDetailsPanel />

      <h3>Recovery phrase</h3>
      {!revealing && !revealedMnemonic && (
        <button className="secondary" onClick={() => setRevealing(true)}>
          Show recovery phrase
        </button>
      )}
      {revealing && !revealedMnemonic && (
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
          />
          {revealError && <p className="error">{revealError}</p>}
          <div className="row">
            <button
              className="secondary"
              onClick={() => {
                setRevealing(false);
                setRevealPwd("");
                setRevealError(null);
              }}
            >
              Cancel
            </button>
            <button onClick={() => void revealSeed()} disabled={!revealPwd}>
              Reveal
            </button>
          </div>
        </>
      )}
      {revealedMnemonic && (
        <>
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
              setRevealing(false);
            }}
          >
            Hide
          </button>
        </>
      )}

      <h3>Connected sites</h3>
      <ConnectionsList />

      <h3>Inspect offer</h3>
      <OfferInspector />

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
  const overall = computeOverallProgress(stage, xchP, catsP, nftsP);

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
              currentStage={stage}
              myStage="xch"
              prog={xchP}
              count={xchCoins}
              countLabel={xchCoins === 1 ? "coin" : "coins"}
              hadFullSync={hadFullSync}
            />
            <SyncStageItem
              label="CATs"
              currentStage={stage}
              myStage="cats"
              prog={catsP}
              count={catAssets}
              countLabel={catAssets === 1 ? "token" : "tokens"}
              hadFullSync={hadFullSync}
            />
            <SyncStageItem
              label="NFTs"
              currentStage={stage}
              myStage="nfts"
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
  currentStage,
  myStage,
  prog,
  count,
  countLabel,
  hadFullSync,
}: {
  label: string;
  currentStage: SyncStage;
  myStage: SyncStage;
  prog: StageProgress;
  count: number;
  countLabel: string;
  hadFullSync: boolean;
}) {
  const active = currentStage === myStage;
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
          {prog.done}/{prog.total}
          {prog.detail ? ` · ${prog.detail}` : ""}
          {stageElapsedSec > 0 ? ` · ${stageElapsedSec}s` : ""}
        </span>
      )}
      {active && (
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
  cats: StageProgress,
  nfts: StageProgress,
): number {
  // Each of the three scan stages contributes a third of the bar.
  const ratio = (p: StageProgress) =>
    p.total > 0 ? Math.min(1, p.done / p.total) : 0;
  const xchR = ratio(xch);
  const catsR = ratio(cats);
  const nftsR = ratio(nfts);
  if (stage === "deriving") return 0.02;
  if (stage === "xch") return xchR / 3;
  if (stage === "cats") return 1 / 3 + catsR / 3;
  if (stage === "nfts") return 2 / 3 + nftsR / 3;
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
      return "Scanning CATs";
    case "nfts":
      return "Scanning NFTs";
    case "done":
      return "Idle";
    case "idle":
    default:
      return "Idle";
  }
}

function formatUsd(n: number): string {
  if (!isFinite(n)) return "0.00";
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
    <div className="result">
      <p className="muted small">
        Run a local <code>ozone-sidecar</code> daemon to sync your wallet
        through real Chia peers (mTLS) instead of coinset.org. The extension
        falls back automatically if the sidecar is unreachable.
      </p>
      <div className="row" style={{ alignItems: "center", gap: 12 }}>
        <label className="row" style={{ alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>Use sidecar when reachable</span>
        </label>
      </div>
      <div className="row" style={{ alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          placeholder="http://127.0.0.1:8765"
          style={{ flex: 1 }}
        />
        <button className="secondary" disabled={busy || urlInput === settings.url} onClick={() => void saveUrl()}>
          Save
        </button>
      </div>
      <div style={{ marginTop: 8 }}>
        <span className="muted">status </span>
        {reachable ? (
          <code style={{ color: "var(--ok, #4ade80)" }}>
            connected · {probe?.peer_addr ?? "?"} · peak #{probe?.peak_height?.toLocaleString() ?? "?"}
          </code>
        ) : settings.enabled ? (
          <code style={{ color: "var(--warn, #fbbf24)" }}>
            sidecar not reachable {probeError ? `(${probeError})` : ""}
          </code>
        ) : (
          <code className="muted">disabled — coinset.org in use</code>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
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
        return (
          <li key={c.origin} className="connection-row">
            <div className="connection-meta">
              <div className="connection-host" title={c.origin}>
                {host}
              </div>
              <div className="muted small">
                Connected {new Date(c.connectedAt).toLocaleDateString()} ·
                {" "}
                {c.methods.includes("*") ? "all methods" : c.methods.join(", ")}
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
    <div>
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
          <div>
            <span className="muted">offered XCH</span>
            <code>{result.offered.xch_mojos} mojos</code>
          </div>
          {result.offered.cats.map((c) => (
            <div key={c.asset_id}>
              <span className="muted">offered CAT {shortHash(c.asset_id)}</span>
              <code>{c.amount}</code>
            </div>
          ))}
          {result.offered.nft_launcher_ids.map((l) => (
            <div key={l}>
              <span className="muted">offered NFT</span>
              <code>{shortHash(l)}</code>
            </div>
          ))}
          <div>
            <span className="muted">requested XCH</span>
            <code>{result.requested.xch_mojos} mojos</code>
          </div>
          {result.requested.cats.map((c) => (
            <div key={c.asset_id}>
              <span className="muted">requested CAT {shortHash(c.asset_id)}</span>
              <code>{c.amount}</code>
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
    </div>
  );
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
                {imgSrc ? (
                  <img
                    src={imgSrc}
                    alt={n.launcher_id}
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <div className="nft-placeholder">NFT</div>
                )}
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
function mojosToCatUnits(mojos: string): string {
  try {
    const m = BigInt(mojos);
    const scale = 1_000n;
    const whole = m / scale;
    const frac = m % scale;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(3, "0").replace(/0+$/, "");
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
        available_mojos: BigInt(
          Math.round((parseFloat(balance?.total_unspent_xch || "0") || 0) * 1_000_000_000_000),
        ),
        coin_count: balance?.unspent_coin_count ?? 0,
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
  const haveEnough =
    selectedAsset.kind === "xch"
      ? selectedAsset.available_mojos >= amountMojos + feeMojos
      : selectedAsset.available_mojos >= amountMojos &&
        BigInt(balance?.total_unspent_mojos ?? "0") >= feeMojos;
  const canSend = addressValid && amountNum > 0 && haveEnough && !sending;

  const send = async () => {
    setSending(true);
    setSubmitError(null);
    setSent(null);
    try {
      const derived = await callEngine<{
        addresses: { index: number; puzzle_hash: string }[];
      }>("derive_addresses", {
        fingerprint: wallet.fingerprint,
        start: 0,
        count: 50,
        testnet: false,
      });
      const phToIndex: Record<string, number> = {};
      for (const a of derived.addresses) {
        phToIndex[a.puzzle_hash] = a.index;
      }

      const fresh = await getCoinSnapshot(wallet.fingerprint);

      if (selectedAsset.kind === "xch") {
        const picked = pickCoinsForSendMulti(
          fresh.coins,
          phToIndex,
          amountMojos + feeMojos,
        );
        if (!picked) {
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
          .filter((c) => !c.spent && phToIndex[c.inner_puzzle_hash] !== undefined)
          .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
        let running = 0n;
        const picked: Array<{
          parent_coin_info: string;
          puzzle_hash: string;
          amount: string;
          inner_puzzle_hash: string;
          derivation_index: number;
          lineage_proof: {
            parent_name: string;
            inner_puzzle_hash: string;
            amount: string;
          };
        }> = [];
        for (const c of sortedCoins) {
          if (running >= amountMojos) break;
          picked.push({
            parent_coin_info: c.parent_coin_info,
            puzzle_hash: c.puzzle_hash,
            amount: c.amount,
            inner_puzzle_hash: c.inner_puzzle_hash,
            derivation_index: phToIndex[c.inner_puzzle_hash]!,
            lineage_proof: c.lineage_proof,
          });
          running += BigInt(c.amount);
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
        <span>Amount ({selectedAsset.ticker})</span>
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
      {sent && (
        <div className="result">
          <div>
            <span className="muted">tx id</span>
            <code>{sent.tx_id}</code>
          </div>
          <div>
            <span className="muted">status</span>
            <code className={sent.status === "SUCCESS" ? "ok" : "warn"}>{sent.status}</code>
          </div>
          {BigInt(sent.change_mojos ?? "0") > 0n && (
            <div>
              <span className="muted">XCH change</span>
              <code>{mojosToXch(sent.change_mojos)} XCH</code>
            </div>
          )}
        </div>
      )}
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

// Popup ↔ Service Worker RPC.
//
// The popup is in the same extension origin as the SW, so we don't need the
// CHIP-0002 permission gate that gates dApp calls. The popup can invoke any
// engine method directly. We just need a thin envelope to forward the call
// + serialize errors.

import { callEngine } from "./engine.js";
import { setActiveWallet } from "./engine.js";
import { clearCoinStore, readCoinStore, totalUnspentMojos, unspentCoinCount } from "./coin-store.js";
import { readSyncTelemetry, tickCoinSync } from "./coin-sync.js";
import { decidePending, listPending } from "./approval.js";
import { getXchPriceUsd, resolveCatMetadata } from "./dexie.js";
import { listConnections, revokeConnection } from "./permissions.js";
import { readSyncState } from "./sync-loop.js";
import { readSidecarSettings, writeSidecarSettings, type SidecarSettings } from "./sidecar-settings.js";
import { sidecarHealth, type SidecarHealth } from "./sidecar-client.js";

export type PopupRpcMessage =
  | { from: "popup"; kind: "engine"; method: string; params: unknown }
  | { from: "popup"; kind: "set-active-wallet"; walletId: string | null }
  | { from: "popup"; kind: "get-sync-state" }
  | { from: "popup"; kind: "get-coin-store"; fingerprint: number }
  | { from: "popup"; kind: "clear-coin-store"; fingerprint: number }
  | { from: "popup"; kind: "force-coin-sync" }
  | { from: "popup"; kind: "get-coin-sync-telemetry" }
  | { from: "popup"; kind: "get-xch-price" }
  | { from: "popup"; kind: "list-connections" }
  | { from: "popup"; kind: "revoke-connection"; origin: string }
  | { from: "popup"; kind: "list-pending-approvals" }
  | { from: "popup"; kind: "decide-approval"; id: string; approved: boolean }
  | { from: "popup"; kind: "get-sidecar-settings" }
  | { from: "popup"; kind: "set-sidecar-settings"; patch: Partial<SidecarSettings> }
  | { from: "popup"; kind: "probe-sidecar"; url?: string };

export type PopupRpcResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { code?: number; message: string } };

export function isPopupMessage(msg: unknown): msg is PopupRpcMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as { from?: unknown };
  return m.from === "popup";
}

export async function handlePopupMessage(
  msg: PopupRpcMessage,
): Promise<PopupRpcResponse> {
  try {
    switch (msg.kind) {
      case "engine": {
        const value = await callEngine(msg.method, msg.params);
        return { ok: true, value };
      }
      case "set-active-wallet": {
        setActiveWallet(msg.walletId);
        if (msg.walletId) {
          await chrome.storage.session.set({ walletId: msg.walletId });
        } else {
          await chrome.storage.session.remove("walletId");
        }
        return { ok: true, value: null };
      }
      case "get-sync-state": {
        const state = await readSyncState();
        return { ok: true, value: state };
      }
      case "get-coin-store": {
        const store = await readCoinStore(msg.fingerprint);

        // Cap the per-message coins payload — wallets with deep history
        // crash the popup renderer when every refresh ships MBs of
        // historical records over chrome.runtime.sendMessage. The popup
        // only ever displays unspent + recent activity, so prune here.

        // ── XCH: every unspent + most recent 200 spent ─────────────────
        const allCoins = Object.values(store.coins);
        const unspent = allCoins.filter((c) => !c.spent);
        const spentSorted = allCoins
          .filter((c) => c.spent)
          .sort((a, b) => b.spent_block_index - a.spent_block_index)
          .slice(0, 200);
        const projectedCoins: typeof store.coins = {};
        for (const c of unspent) projectedCoins[c.coin_id] = c;
        for (const c of spentSorted) projectedCoins[c.coin_id] = c;

        // ── CATs: drop assets with 0 unspent balance, and within each
        //         kept asset, only ship the unspent coins (plus the 50
        //         most recent spent for the Activity feed). A wallet with
        //         many historical CATs would otherwise ship MBs/refresh.
        const projectedCats: NonNullable<typeof store.cats> = {};
        const storeCats = store.cats ?? {};
        for (const [assetId, cat] of Object.entries(storeCats)) {
          if ((cat.unspent_coin_count ?? 0) === 0) continue;
          const unspentCoins = cat.coins.filter((c) => !c.spent);
          const spentCoins = cat.coins
            .filter((c) => c.spent)
            .sort((a, b) => b.spent_block_index - a.spent_block_index)
            .slice(0, 50);
          projectedCats[assetId] = {
            ...cat,
            coins: [...unspentCoins, ...spentCoins],
          };
        }

        // ── NFTs: only ship unspent (UI doesn't show spent NFTs anywhere).
        const projectedNfts: NonNullable<typeof store.nfts> = {};
        const storeNfts = store.nfts ?? {};
        for (const [launcher, nft] of Object.entries(storeNfts)) {
          if (nft.spent) continue;
          projectedNfts[launcher] = nft;
        }

        const assetIds = Object.keys(projectedCats);
        const metadata = await resolveCatMetadata(assetIds).catch(() => ({}));

        return {
          ok: true,
          value: {
            last_synced_height: store.last_synced_height,
            unspent_mojos: totalUnspentMojos(store),
            unspent_count: unspentCoinCount(store),
            coins: projectedCoins,
            cats: projectedCats,
            cats_synced_at: store.cats_synced_at ?? null,
            cat_metadata: metadata,
            nfts: projectedNfts,
            nfts_synced_at: store.nfts_synced_at ?? null,
            // Surface the hardened-path map so the popup can detect when
            // a discovered NFT/CAT was received at a hardened derivation
            // (the engine's transfer_nft/send_cat only handle unhardened
            // paths today — see App.tsx NftDetail.transfer for the gate).
            hardened_phs: store.hardened_phs ?? {},
          },
        };
      }
      case "clear-coin-store": {
        await clearCoinStore(msg.fingerprint);
        return { ok: true, value: null };
      }
      case "force-coin-sync": {
        await tickCoinSync({ force: true });
        return { ok: true, value: null };
      }
      case "get-coin-sync-telemetry": {
        const t = await readSyncTelemetry();
        return { ok: true, value: t };
      }
      case "get-xch-price": {
        const usd = await getXchPriceUsd();
        return { ok: true, value: usd };
      }
      case "list-connections": {
        const conns = await listConnections();
        return { ok: true, value: conns };
      }
      case "revoke-connection": {
        await revokeConnection(msg.origin);
        return { ok: true, value: null };
      }
      case "list-pending-approvals": {
        return { ok: true, value: listPending() };
      }
      case "decide-approval": {
        const ok = decidePending(msg.id, msg.approved);
        return { ok: true, value: ok };
      }
      case "get-sidecar-settings": {
        const s = await readSidecarSettings();
        return { ok: true, value: s };
      }
      case "set-sidecar-settings": {
        const next = await writeSidecarSettings(msg.patch);
        return { ok: true, value: next };
      }
      case "probe-sidecar": {
        const current = await readSidecarSettings();
        const settings: SidecarSettings = msg.url
          ? { ...current, url: msg.url }
          : current;
        try {
          const h: SidecarHealth = await sidecarHealth(settings);
          return { ok: true, value: h };
        } catch (e) {
          return {
            ok: true,
            value: { reachable: false, error: (e as Error).message },
          };
        }
      }
    }
  } catch (err) {
    const e = err as Error & { code?: number };
    return {
      ok: false,
      error: { code: e.code, message: e.message ?? String(err) },
    };
  }
}

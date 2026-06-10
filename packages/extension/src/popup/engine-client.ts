// Popup-side client for talking to the engine through the service worker.
//
// The popup never loads WASM itself — only the SW owns the wallet. Every
// call goes through chrome.runtime.sendMessage with the `from: "popup"`
// envelope handled in background/popup-rpc.ts.

import type { PopupRpcMessage, PopupRpcResponse } from "../background/popup-rpc";

export async function callEngine<T = unknown>(
  method: string,
  params: unknown = {},
): Promise<T> {
  const msg: PopupRpcMessage = { from: "popup", kind: "engine", method, params };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) {
    const err = new Error(res.error.message) as Error & { code?: number };
    err.code = res.error.code;
    throw err;
  }
  return res.value as T;
}

export async function setActiveWallet(walletId: string | null): Promise<void> {
  const msg: PopupRpcMessage = { from: "popup", kind: "set-active-wallet", walletId };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) {
    throw new Error(res.error.message);
  }
}

export interface SyncState {
  peak_height: number;
  peak_header_hash: string;
  synced: boolean;
  sync_mode: boolean;
  mempool_size: number;
  mempool_cost: number;
  difficulty: number;
  ticked_at: number;
  error?: string;
}

export async function getSyncState(): Promise<SyncState | null> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-sync-state" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) {
    throw new Error(res.error.message);
  }
  return (res.value as SyncState | null) ?? null;
}

export interface CatCoin {
  coin_id: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: string;
  inner_puzzle_hash: string;
  hidden_puzzle_hash?: string | null;
  hint: string;
  confirmed_block_index: number;
  spent: boolean;
  spent_block_index: number;
  lineage_proof: {
    parent_name: string;
    inner_puzzle_hash: string;
    amount: string;
  };
}

export interface CatAsset {
  asset_id: string;
  total_unspent_mojos: string;
  unspent_coin_count: number;
  coins: CatCoin[];
}

export interface DexieCatMetadata {
  asset_id: string;
  code?: string;
  name?: string;
  image_url?: string;
  decimals?: number;
  fetched_at: number;
}

export interface NftMetadataView {
  edition_number?: number;
  edition_total?: number;
  data_uris?: string[];
  data_hash?: string;
  metadata_uris?: string[];
  metadata_hash?: string;
  license_uris?: string[];
  license_hash?: string;
}

export interface NftView {
  launcher_id: string;
  coin_id: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: string;
  metadata: NftMetadataView;
  metadata_updater_puzzle_hash: string;
  current_owner_did: string | null;
  royalty_puzzle_hash: string;
  royalty_basis_points: number;
  p2_puzzle_hash: string;
  hint: string;
  confirmed_block_index: number;
  spent: boolean;
  spent_block_index: number;
}

export interface CoinSnapshot {
  last_synced_height: number;
  unspent_mojos: string;
  unspent_count: number;
  coins: Record<string, {
    coin_id: string;
    parent_coin_info: string;
    puzzle_hash: string;
    amount: string;
    confirmed_block_index: number;
    spent: boolean;
    spent_block_index: number;
    timestamp: number;
    hint?: string;
  }>;
  cats?: Record<string, CatAsset>;
  cats_synced_at?: number | null;
  cat_metadata?: Record<string, DexieCatMetadata>;
  nfts?: Record<string, NftView>;
  nfts_synced_at?: number | null;
  /**
   * Puzzle-hash → derivation-index map for hardened paths the wallet
   * cached during unlock. `hardened_phs[ph.toLowerCase()]` is the
   * derivation index. Used by NftDetail.transfer to detect when an NFT
   * sits at a hardened path (which the engine's transfer_nft can't
   * sign yet).
   */
  hardened_phs?: Record<string, number>;
}

export async function getCoinSnapshot(fingerprint: number): Promise<CoinSnapshot> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-coin-store", fingerprint };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as CoinSnapshot;
}

export async function clearCoinSnapshot(fingerprint: number): Promise<void> {
  const msg: PopupRpcMessage = { from: "popup", kind: "clear-coin-store", fingerprint };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
}

export async function forceCoinSync(): Promise<void> {
  const msg: PopupRpcMessage = { from: "popup", kind: "force-coin-sync" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
}

export type SyncStage = "idle" | "deriving" | "xch" | "cats" | "nfts" | "done";

export interface StageProgress {
  done: number;
  total: number;
  found?: number;
  last_warning?: string | null;
  detail?: string | null;
  started_at?: number | null;
  block_from?: number | null;
  block_to?: number | null;
  candidates?: number;
}

export interface CoinSyncTelemetry {
  fingerprint: number | null;
  last_attempt_at: number;
  last_success_at: number | null;
  last_full_sync_at: number | null;
  last_error: string | null;
  last_peak_height: number;
  last_new_coins: number;
  stage: SyncStage;
  tick_started_at: number | null;
  stage_progress: {
    xch: StageProgress;
    cats: StageProgress;
    nfts: StageProgress;
  };
  totals: {
    xch_coins: number;
    cat_assets: number;
    nfts: number;
  };
}

export async function getCoinSyncTelemetry(): Promise<CoinSyncTelemetry | null> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-coin-sync-telemetry" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return (res.value as CoinSyncTelemetry | null) ?? null;
}

export async function getXchPriceUsd(): Promise<number | null> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-xch-price" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) return null;
  return (res.value as number | null) ?? null;
}

export interface MempoolDebugEntry {
  tx_id: string;
  observed_at: number;
  additions_count: number;
  removals_count: number;
  total_added_mojos: string;
  total_removed_mojos: string;
  mine: "incoming" | "outgoing" | "both" | "none" | "unknown";
  fp: number | null;
  matched_in_phs: string[];
  matched_out_cat_assets: string[];
  matched_out_xch: boolean;
  shape: "xch" | "asset" | "mixed";
}

export interface MempoolWatchStats {
  messages: number;
  lastEvent: string;
  lastSeenAt: number;
  eventTypes: Record<string, number>;
  msgsPerSec: number;
  socketOpen: boolean;
  socketState: string;
  rawSamples: string[];
}

export interface MempoolDebugSnapshot {
  stats: MempoolWatchStats;
  feed: MempoolDebugEntry[];
}

export async function getMempoolDebug(): Promise<MempoolDebugSnapshot> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-mempool-debug" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as MempoolDebugSnapshot;
}

export type ConnectionScope = "full" | "read-only";

export interface ConnectionRecord {
  origin: string;
  connectedAt: number;
  /** Last authorized call; the sliding-expiry window is measured from here. */
  lastUsedAt: number;
  /** Connection is dead once Date.now() > expiresAt (7-day sliding window). */
  expiresAt: number;
  /** `full` → signing allowed (per-call approved); `read-only` → reads only. */
  scope: ConnectionScope;
  methods: string[];
}

export async function listConnections(): Promise<ConnectionRecord[]> {
  const msg: PopupRpcMessage = { from: "popup", kind: "list-connections" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return (res.value as ConnectionRecord[]) ?? [];
}

export async function revokeConnection(origin: string): Promise<void> {
  const msg: PopupRpcMessage = { from: "popup", kind: "revoke-connection", origin };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
}

export interface PendingApproval {
  id: string;
  origin: string;
  method: string;
  params: unknown;
  createdAt: number;
}

export async function listPendingApprovals(): Promise<PendingApproval[]> {
  const msg: PopupRpcMessage = { from: "popup", kind: "list-pending-approvals" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return (res.value as PendingApproval[]) ?? [];
}

export async function decideApproval(
  id: string,
  approved: boolean,
  overrides?: Record<string, unknown>,
): Promise<void> {
  const msg: PopupRpcMessage = {
    from: "popup",
    kind: "decide-approval",
    id,
    approved,
    ...(overrides ? { overrides } : {}),
  };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
}

export interface SidecarSettings {
  enabled: boolean;
  url: string;
}

export interface SidecarProbe {
  status?: string;
  network?: string;
  peer_connected?: boolean;
  peer_addr?: string | null;
  peak_height?: number | null;
  reachable?: false;
  error?: string;
}

export async function getSidecarSettings(): Promise<SidecarSettings> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-sidecar-settings" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as SidecarSettings;
}

export async function setSidecarSettings(
  patch: Partial<SidecarSettings>,
): Promise<SidecarSettings> {
  const msg: PopupRpcMessage = { from: "popup", kind: "set-sidecar-settings", patch };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as SidecarSettings;
}

export async function probeSidecar(url?: string): Promise<SidecarProbe> {
  const msg: PopupRpcMessage = { from: "popup", kind: "probe-sidecar", url };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as SidecarProbe;
}

export interface CompatSettings {
  legacyGoby: boolean;
}

export async function getCompatSettings(): Promise<CompatSettings> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-compat-settings" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as CompatSettings;
}

export async function setCompatSettings(
  patch: Partial<CompatSettings>,
): Promise<CompatSettings> {
  const msg: PopupRpcMessage = { from: "popup", kind: "set-compat-settings", patch };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as CompatSettings;
}

export interface NotifSettings {
  enabled: boolean;
  incomingPending: boolean;
  incomingConfirmed: boolean;
  outgoingExternal: boolean;
  outgoingConfirmed: boolean;
}

export async function getNotifSettings(): Promise<NotifSettings> {
  const msg: PopupRpcMessage = { from: "popup", kind: "get-notif-settings" };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as NotifSettings;
}

export async function setNotifSettings(
  patch: Partial<NotifSettings>,
): Promise<NotifSettings> {
  const msg: PopupRpcMessage = { from: "popup", kind: "set-notif-settings", patch };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as NotifSettings;
}

/**
 * Decoded view of a signCoinSpends / sendTransaction bundle: per-coin
 * kind + outputs, plus a wallet-wide summary so the approval popup can
 * tell the user what will actually move on chain before they sign.
 *
 * Outputs flagged `is_ours: true` are landing back at one of our
 * derived puzzle hashes (change / self-transfer). `is_ours: false` is
 * the value leaving the wallet.
 */
export interface CoinSpendAnalysisOutput {
  puzzle_hash: string;
  amount: string;
  is_ours: boolean;
  hint?: string | null;
}

export interface CoinSpendAnalysisItem {
  coin_id: string;
  kind: "xch" | "cat" | "unknown";
  asset_id?: string | null;
  input_amount: string;
  input_is_ours: boolean;
  fee_mojos: string;
  /** AGG_SIG conditions this spend forces the wallet to produce. */
  agg_sig_count: number;
  /** Of those, the replayable AGG_SIG_UNSAFE kind (message not coin-bound). */
  agg_sig_unsafe_count: number;
  outputs: CoinSpendAnalysisOutput[];
}

export interface CoinSpendAnalysis {
  spends: CoinSpendAnalysisItem[];
  summary: {
    total_xch_out_external: string;
    total_xch_change: string;
    total_cat_out_by_asset: Record<string, string>;
    total_fee_mojos: string;
    /** Mojos created by unrecognised-puzzle spends to non-owner destinations. */
    total_unknown_out_mojos: string;
    unknown_spend_count: number;
    /** Total AGG_SIG conditions across the bundle. */
    agg_sig_count: number;
    /** Replayable AGG_SIG_UNSAFE conditions — a phishing red flag. */
    agg_sig_unsafe_count: number;
  };
}

export async function analyzeCoinSpends(
  coinSpends: Array<{
    coin: { parent_coin_info: string; puzzle_hash: string; amount: string | number };
    puzzle_reveal: string;
    solution: string;
  }>,
): Promise<CoinSpendAnalysis> {
  const msg: PopupRpcMessage = {
    from: "popup",
    kind: "analyze-coin-spends",
    coinSpends,
  };
  const res = (await chrome.runtime.sendMessage(msg)) as PopupRpcResponse;
  if (!res.ok) throw new Error(res.error.message);
  return res.value as CoinSpendAnalysis;
}

/**
 * After a successful `unlock_keychain`, derive the wallet's first 50 hardened
 * receive puzzle hashes and stash them under
 * `chrome.storage.local["hardened_phs.<fp>"]`. The map is read by the
 * background sync loop on every tick so we can include hardened addresses in
 * scan_puzzle_hashes / scan_cats / scan_nfts even after the SW restarts and
 * loses the unlocked SecretKey.
 *
 * Hardened PHs derive from the SECRET key, so this MUST be called while the
 * wallet is unlocked. Returns the cached map (puzzle_hash → derivation_index).
 */
export async function cacheHardenedPhs(
  fingerprint: number,
  count = 50,
): Promise<Record<string, number>> {
  const res = await callEngine<{
    addresses: { index: number; puzzle_hash: string; address: string }[];
  }>("derive_addresses_hardened", { fingerprint, start: 0, count, testnet: false });
  const map: Record<string, number> = {};
  for (const a of res.addresses) map[a.puzzle_hash] = a.index;
  const key = `hardened_phs.${fingerprint}`;
  await chrome.storage.local.set({ [key]: map });
  return map;
}

export async function getCachedHardenedPhs(
  fingerprint: number,
): Promise<Record<string, number>> {
  const key = `hardened_phs.${fingerprint}`;
  const data = await chrome.storage.local.get(key);
  return (data[key] as Record<string, number> | undefined) ?? {};
}

export interface SendXchResult {
  tx_id: string;
  status: string;
  error?: string | null;
  change_mojos: string;
}

export interface PickedCoin {
  coin_id: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: string;
  derivation_index: number;
}

type CandidateCoin = {
  coin_id: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: string;
  spent: boolean;
};

function toPicked(c: CandidateCoin, idx: number): PickedCoin {
  return {
    coin_id: c.coin_id,
    parent_coin_info: c.parent_coin_info,
    puzzle_hash: c.puzzle_hash,
    amount: c.amount,
    derivation_index: idx,
  };
}

/** Pick the smallest unspent coin whose amount covers needed mojos. */
export function pickCoinForSend(
  coins: Record<string, CandidateCoin>,
  phToIndex: Record<string, number>,
  neededMojos: bigint,
): PickedCoin | null {
  const candidates = Object.values(coins)
    .filter((c) => !c.spent && BigInt(c.amount) >= neededMojos)
    .filter((c) => phToIndex[c.puzzle_hash] !== undefined);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  return toPicked(candidates[0]!, phToIndex[candidates[0]!.puzzle_hash]!);
}

/**
 * Select multiple coins that together cover `neededMojos`. Largest-first to
 * minimise the number of inputs. Returns null when the unspent total is
 * still insufficient.
 */
export function pickCoinsForSendMulti(
  coins: Record<string, CandidateCoin>,
  phToIndex: Record<string, number>,
  neededMojos: bigint,
  maxInputs = 50,
): PickedCoin[] | null {
  const available = Object.values(coins)
    .filter((c) => !c.spent && phToIndex[c.puzzle_hash] !== undefined)
    .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
  const picked: PickedCoin[] = [];
  let running = 0n;
  for (const c of available) {
    if (running >= neededMojos) break;
    if (picked.length >= maxInputs) break;
    picked.push(toPicked(c, phToIndex[c.puzzle_hash]!));
    running += BigInt(c.amount);
  }
  if (running < neededMojos) return null;
  return picked;
}

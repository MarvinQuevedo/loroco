// JS-side coin record cache, keyed per fingerprint.
//
// We don't have the Rust storage bridge wired yet, so the background SW
// drives the sync loop and writes coin records into chrome.storage.local.
// The popup reads from this same store via popup-rpc.
//
// Layout per fingerprint:
//   chrome.storage.local["coins.<fp>"] = {
//     last_synced_height: number,           // global high-water mark
//     ph_heights: { [ph_hex]: number },     // per-ph sync mark (reorg safety)
//     coins: { [coin_id_hex]: CoinRecord }, // every coin we've ever seen
//   }

const KEY_PREFIX = "coins.";

export interface CoinRecord {
  coin_id: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: string;
  coinbase: boolean;
  confirmed_block_index: number;
  spent: boolean;
  spent_block_index: number;
  timestamp: number;
  hint?: string;
  /**
   * Set to true when WE marked the coin spent before the chain confirmed it
   * (after a successful broadcast in transfer/sendTransaction/takeOffer). The
   * coin-sync tick reconciles: confirmed spent → clears `pending`, writes the
   * real `spent_block_index`. Still unspent past `PENDING_TTL_MS` → reverts.
   * Treat as "spent" in any UI/balance computation; the only consumer that
   * should care about the flag is the reconciliation loop.
   */
  pending?: boolean;
  /** Epoch ms when `pending` was set. Used by the TTL revert rule. */
  pending_at?: number;
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
  /** LineageProof from the parent CAT spend — required to spend. */
  lineage_proof: {
    parent_name: string;
    inner_puzzle_hash: string;
    amount: string;
  };
  /** See `CoinRecord.pending`. */
  pending?: boolean;
  /** See `CoinRecord.pending_at`. */
  pending_at?: number;
}

export interface CatAsset {
  asset_id: string;
  total_unspent_mojos: string;
  unspent_coin_count: number;
  coins: CatCoin[];
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

/**
 * Item observed in the mempool that creates a coin going TO us — addition
 * with a puzzle_hash in our derived set, before any block confirms it.
 * Migrates to a real `CoinRecord` on the next scan_puzzle_hashes tick.
 */
export interface MempoolIncoming {
  tx_id: string;
  parent_coin_info: string;
  puzzle_hash: string;
  amount: string;
  /** Set when we detected an incoming CAT via hint match. Null for XCH. */
  asset_id?: string | null;
  /** When mempool-watch first saw this addition. Used for TTL expiry. */
  seen_at: number;
}

/**
 * Item observed in the mempool that spends one of OUR coins — removal whose
 * `coin_id` is in `store.coins` or `store.cats[*].coins`. Lets us show "you
 * are spending X" before the block confirms it, and lets the optimistic
 * spent reconciliation in coin-sync extend the TTL when push_tx clearly
 * landed.
 */
export interface MempoolOutgoing {
  tx_id: string;
  spent_xch_coin_ids: string[];
  /** Per-asset CAT spends: asset_id_hex → coin_ids. */
  spent_cat_coin_ids: Record<string, string[]>;
  seen_at: number;
}

export interface MempoolSnapshot {
  incoming: MempoolIncoming[];
  outgoing: MempoolOutgoing[];
  last_polled_at: number;
}

export interface CoinStore {
  last_synced_height: number;
  ph_heights: Record<string, number>;
  coins: Record<string, CoinRecord>;
  /** CATs grouped by asset_id, refreshed by the scan_cats path. */
  cats?: Record<string, CatAsset>;
  cats_synced_at?: number;
  /** NFTs keyed by launcher_id, refreshed by the scan_nfts path. */
  nfts?: Record<string, NftView>;
  nfts_synced_at?: number;
  /**
   * Current view of the mempool from the mempool-watch poller. Items expire
   * after MEMPOOL_TTL_MS without seeing them again in a poll, so a tx that
   * the indexer evicted disappears from the UI on its own.
   */
  mempool?: MempoolSnapshot;
  /**
   * Per-PH cursor for `get_coin_records_by_hint` start_height. After each
   * successful CAT chunk we advance the entry to peak_height so the next
   * tick only fetches NEW hint matches since then. Same idea as ph_heights
   * but for the hint-based scan path. Backing off REORG_WINDOW handles
   * short reorgs.
   */
  cat_hint_heights?: Record<string, number>;
  nft_hint_heights?: Record<string, number>;
  /**
   * Hardened-derivation puzzle hashes for this wallet, captured ONCE after
   * unlock via `derive_addresses_hardened`. Cached publicly (hashes are not
   * secret) so subsequent sync ticks don't need the wallet unlocked again.
   * Map: puzzle_hash (lowercase 0x-prefixed) → derivation_index.
   * Sage uses both hardened and unhardened paths for receive addresses,
   * so without this set we miss ~6 of 7 NFTs on a real-world wallet.
   */
  hardened_phs?: Record<string, number>;
  /**
   * Two-phase sync — Phase 1 (hint fetch) deposits raw candidates here so
   * SW death doesn't lose work. Phase 2 (parse) drains the queue. If SW
   * dies mid-parse, candidates stay enqueued for the next tick. Keyed by
   * coin_id so we naturally deduplicate.
   */
  pending_nft_candidates?: Record<string, RawNftCandidate>;
  pending_cat_candidates?: Record<string, RawCatCandidate>;
}

/**
 * Hint-matched coin record returned by `asset_scan_hints`. Asset-type-
 * agnostic — both NFT phase-2 (`nft_parse_candidates`) and CAT phase-2
 * (`cat_parse_candidates`) consume the same shape and decide what each
 * candidate actually is by parsing its parent spend.
 */
export interface RawAssetCandidate {
  hint: string;
  coin: { parent_coin_info: string; puzzle_hash: string; amount: string };
  coin_id: string;
  confirmed_block_index: number;
  spent: boolean;
  spent_block_index: number;
  derivation_index: number;
  derivation_kind: "hardened" | "unhardened";
}

/** @deprecated Use `RawAssetCandidate`. Kept as alias for in-flight refactors. */
export type RawNftCandidate = RawAssetCandidate;

/** @deprecated Use `RawAssetCandidate`. Kept as alias for in-flight refactors. */
export type RawCatCandidate = RawAssetCandidate;

const empty = (): CoinStore => ({
  last_synced_height: 0,
  ph_heights: {},
  coins: {},
  cats: {},
  nfts: {},
  cat_hint_heights: {},
  nft_hint_heights: {},
  hardened_phs: {},
  pending_nft_candidates: {},
  pending_cat_candidates: {},
  mempool: { incoming: [], outgoing: [], last_polled_at: 0 },
});

/**
 * How long a mempool item is allowed to sit in `store.mempool` without
 * appearing in a fresh poll before we evict it. 5 minutes lines up with
 * Chia's actual mempool eviction window — anything stale beyond that is
 * almost certainly a tx that got dropped (fee too low, expired, etc.).
 */
export const MEMPOOL_TTL_MS = 5 * 60_000;

export async function readCoinStore(fingerprint: number): Promise<CoinStore> {
  const key = `${KEY_PREFIX}${fingerprint}`;
  const data = await chrome.storage.local.get(key);
  return (data[key] as CoinStore | undefined) ?? empty();
}

export async function writeCoinStore(fingerprint: number, store: CoinStore): Promise<void> {
  const key = `${KEY_PREFIX}${fingerprint}`;
  await chrome.storage.local.set({ [key]: store });
}

export async function clearCoinStore(fingerprint: number): Promise<void> {
  const key = `${KEY_PREFIX}${fingerprint}`;
  await chrome.storage.local.remove(key);
}

/** Total unspent XCH (as mojos BigInt string) for direct-receive coins. */
export function totalUnspentMojos(store: CoinStore): string {
  let total = 0n;
  for (const c of Object.values(store.coins)) {
    if (!c.spent) total += BigInt(c.amount);
  }
  return total.toString();
}

export function unspentCoinCount(store: CoinStore): number {
  let count = 0;
  for (const c of Object.values(store.coins)) {
    if (!c.spent) count += 1;
  }
  return count;
}

/**
 * How long an optimistic `pending` coin is allowed to sit unconfirmed before
 * the reconciliation loop reverts it. Sized for "push_tx success but never
 * landed in a block" failure modes: typical mainnet inclusion is 5–30s,
 * 2 minutes leaves comfortable headroom for full-mempool periods.
 */
export const PENDING_TTL_MS = 120_000;

/**
 * Mark XCH coins as spent optimistically. `coinIds` must already exist in
 * `store.coins` (we picked them as inputs); unknown ids are silently skipped.
 * The coin-sync tick reconciles the `pending` flag against `check_coins_spent`.
 */
export function markXchSpentOptimistic(store: CoinStore, coinIds: string[]): void {
  const now = Date.now();
  for (const id of coinIds) {
    const c = store.coins[id];
    if (c && !c.spent) {
      c.spent = true;
      c.pending = true;
      c.pending_at = now;
    }
  }
}

/** Mark CAT coins as spent optimistically inside `store.cats[assetId]`. */
export function markCatSpentOptimistic(
  store: CoinStore,
  assetIdHex: string,
  coinIds: string[],
): void {
  if (!store.cats) return;
  const cat = store.cats[assetIdHex] ?? store.cats[assetIdHex.replace(/^0x/, "")];
  if (!cat) return;
  const wanted = new Set(coinIds);
  const now = Date.now();
  let unspent = 0;
  let total = 0n;
  for (const c of cat.coins) {
    if (wanted.has(c.coin_id) && !c.spent) {
      c.spent = true;
      c.pending = true;
      c.pending_at = now;
    }
    if (!c.spent) {
      unspent += 1;
      total += BigInt(c.amount);
    }
  }
  cat.unspent_coin_count = unspent;
  cat.total_unspent_mojos = total.toString();
}

/**
 * For raw spend bundles (`sendTransaction`) we only know each input by its
 * outpoint `{parent_coin_info, puzzle_hash, amount}`. Find the matching XCH
 * `coin_id` in `store.coins`, or null if we don't track this coin.
 */
export function findXchCoinIdByOutpoint(
  store: CoinStore,
  parentCoinInfo: string,
  puzzleHash: string,
  amount: string,
): string | null {
  for (const c of Object.values(store.coins)) {
    if (
      c.parent_coin_info === parentCoinInfo &&
      c.puzzle_hash === puzzleHash &&
      c.amount === amount
    ) {
      return c.coin_id;
    }
  }
  return null;
}

/** Same as `findXchCoinIdByOutpoint`, but scans every CAT bucket. */
export function findCatCoinIdByOutpoint(
  store: CoinStore,
  parentCoinInfo: string,
  puzzleHash: string,
  amount: string,
): { assetId: string; coinId: string } | null {
  if (!store.cats) return null;
  for (const [assetId, cat] of Object.entries(store.cats)) {
    for (const c of cat.coins) {
      if (
        c.parent_coin_info === parentCoinInfo &&
        c.puzzle_hash === puzzleHash &&
        c.amount === amount
      ) {
        return { assetId, coinId: c.coin_id };
      }
    }
  }
  return null;
}

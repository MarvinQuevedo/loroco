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

/** Raw NFT candidate as returned by `nft_scan_hints` — awaiting parse. */
export interface RawNftCandidate {
  hint: string;
  coin: { parent_coin_info: string; puzzle_hash: string; amount: string };
  coin_id: string;
  confirmed_block_index: number;
  spent: boolean;
  spent_block_index: number;
  derivation_index: number;
  derivation_kind: "hardened" | "unhardened";
}

/** Raw CAT candidate as returned by `cat_scan_hints` — awaiting parse. */
export interface RawCatCandidate {
  hint: string;
  coin: { parent_coin_info: string; puzzle_hash: string; amount: string };
  coin_id: string;
  confirmed_block_index: number;
  spent: boolean;
  spent_block_index: number;
  derivation_index: number;
  derivation_kind: "hardened" | "unhardened";
}

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
});

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

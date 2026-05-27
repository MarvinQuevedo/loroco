// CHIP-0002 + Goby extensions — wire types
// Source: docs.goby.app + chips/chip-0002.md + vendor/sage walletconnect commands

export type ChainId = "mainnet" | "testnet11" | (string & {});

export type Hex = `0x${string}` | string;
export type Amount = number | string; // accept both; carry as string internally for >2^53 mojos

export interface Coin {
  parent_coin_info: Hex;
  puzzle_hash: Hex;
  amount: number;
}

export interface CoinSpend {
  coin: Coin;
  puzzle_reveal: Hex;
  solution: Hex;
}

export interface SpendBundle {
  coin_spends: CoinSpend[];
  aggregated_signature: Hex;
}

export interface SpendableCoin {
  coin: Coin;
  coinName: Hex;
  puzzle: Hex;
  confirmedBlockIndex: number;
  locked: boolean;
  lineageProof?: {
    parentName?: Hex;
    innerPuzzleHash?: Hex;
    amount?: number;
  };
}

export interface AssetBalance {
  confirmed: string; // mojos as string
  spendable: string;
  spendableCoinCount: number;
}

export type AssetType = "cat" | "did" | "nft" | null;

export enum MempoolInclusionStatus {
  SUCCESS = 1,
  PENDING = 2,
  FAILED = 3,
}

export interface TransactionResp {
  status: MempoolInclusionStatus;
  error?: string | null;
}

// ─── Method param/return maps ────────────────────────────────────────────────

export interface NftRoyaltyView {
  royalty_address?: string;
  royalty_percentage?: number;
}

export interface NftInfo {
  launcher_id: Hex;
  nft_coin_id: Hex;
  owner_did?: Hex | null;
  royalty_address?: Hex | null;
  royalty_percentage?: number;
  data_uris: string[];
  data_hash?: Hex | null;
  metadata_uris: string[];
  metadata_hash?: Hex | null;
  license_uris: string[];
  license_hash?: Hex | null;
  edition_number?: number;
  edition_total?: number;
  p2_puzzle_hash?: Hex | null;
}

export interface ChiaMethodMap {
  // CHIP-0002 — Connection & meta
  chainId: { params: void; result: ChainId };
  connect: { params: { eager?: boolean } | undefined; result: boolean };
  walletSwitchChain: { params: { chainId: ChainId }; result: null };
  walletWatchAsset: {
    params: {
      type: string;
      options: { assetId: Hex; symbol: string; logo?: string };
    };
    result: boolean;
  };

  // Goby-legacy account helpers. dApps built against Goby (dexie.space,
  // tibetswap, …) use these instead of `getPublicKeys`. Return XCH addresses
  // for the connected origin.
  //   `requestAccounts` triggers an approval popup if the origin isn't
  //   connected yet, then returns the address list. Acts like `connect` +
  //   `accounts` in one round-trip.
  //   `accounts` returns the connected addresses WITHOUT prompting; throws
  //   4900 ("not connected") when called by an un-approved origin.
  requestAccounts: { params: void; result: string[] };
  accounts: { params: void; result: string[] };

  // CHIP-0002 — Read
  getPublicKeys: {
    params: { limit?: number; offset?: number; hardened?: boolean } | undefined;
    result: Hex[];
  };
  filterUnlockedCoins: {
    params: { coinNames: Hex[] };
    result: Hex[];
  };
  getAssetCoins: {
    params: {
      type: AssetType;
      assetId: Hex | null;
      includedLocked?: boolean;
      offset?: number;
      limit?: number;
    };
    result: SpendableCoin[];
  };
  getAssetBalance: {
    params: { type: AssetType; assetId: Hex | null };
    result: AssetBalance;
  };

  // CHIP-0002 — Signing
  signCoinSpends: {
    params: { coinSpends: CoinSpend[]; partialSign?: boolean };
    result: Hex; // BLS aggregated signature
  };
  signMessage: {
    params: { message: Hex; publicKey: Hex };
    result: Hex;
  };

  // Goby extensions
  //
  // Also exposed as `chia_send` (Sage WC2). The WC2 shape uses `address`
  // instead of `to` and returns `{}` instead of `{id}` — the handler
  // detects which name the dApp used and remaps inputs + outputs accordingly.
  transfer: {
    params: {
      /** Recipient bech32m address. Required. (`address` accepted as Sage WC2 alias.) */
      to?: string;
      /** Sage WC2 name for `to`. Handler merges them. */
      address?: string;
      amount: Amount;
      assetId?: Hex | "" | null;
      memos?: Hex[];
      fee?: Amount;
    };
    result: { id: Hex } | Record<string, never>;
  };
  sendTransaction: {
    params: { spendBundle: SpendBundle };
    result: TransactionResp[];
  };
  createOffer: {
    params: {
      offerAssets: Array<{ assetId: Hex | ""; amount: Amount }>;
      requestAssets: Array<{ assetId: Hex | ""; amount: Amount }>;
      fee?: Amount;
    };
    result: { id: Hex; offer: string };
  };
  takeOffer: {
    params: { offer: string; fee?: Amount };
    result: { id: Hex };
  };

  // ─── Sage WalletConnect2 extras ──────────────────────────────────────────
  // These mirror the WC2 surface Sage already supports natively. They are
  // exposed through window.chia so dApps that target Sage's WC API (sage-wc.app,
  // dexie marketplace tooling) work without a WC2 pairing.

  /**
   * Sign a "Chia Signed Message" using the secret key whose puzzle is derived
   * from this address. Mirrors `sage_api::wallet_connect::SignMessageByAddress`.
   */
  signMessageByAddress: {
    params: { message: Hex; address: string };
    result: { publicKey: Hex; signature: Hex };
  };

  /** List NFTs owned by the wallet, paginated. */
  getNFTs: {
    params: {
      limit?: number;
      offset?: number;
      didId?: Hex | null;
      /** Sage WC2 only — alias for didId/collection filter. */
      collectionId?: string | null;
    } | undefined;
    result: NftInfo[] | { nfts: NftWcInfo[] };
  };

  /** Resolve a single NFT by launcher id or coin id. */
  getNFTInfo: {
    params: { coinId?: Hex; launcherId?: Hex };
    result: NftInfo | null;
  };

  /**
   * Cancel an offer the wallet previously made. If `local` is true the offer
   * is only removed from local tracking (matches Goby's `cancelOffer({secure:false})`).
   * If false, a cancellation spend is broadcast.
   */
  cancelOffer: {
    params: { id: Hex; fee?: Amount; secure?: boolean };
    result: { id: Hex; cancelled: boolean } | Record<string, never>;
  };

  /** Sage WC2 — returns the wallet's primary receive address. */
  getAddress: {
    params: Record<string, never> | undefined;
    result: { address: string };
  };

  /**
   * Sage WC2 — bulk-mint NFTs against a DID. Stub today: throws MethodNotFound
   * 4004 until the WASM engine endpoint (`bulk_mint_nfts`) lands. Spec mirrors
   * `vendor/sage/src/walletconnect/commands.ts:chia_bulkMintNfts`.
   */
  bulkMintNfts: {
    params: {
      did: string;
      fee?: Amount;
      nfts: Array<{
        address?: string;
        royaltyAddress?: string;
        royaltyTenThousandths?: number;
        dataUris?: string[];
        dataHash?: Hex;
        metadataUris?: string[];
        metadataHash?: Hex;
        licenseUris?: string[];
        licenseHash?: Hex;
        editionNumber?: number;
        editionTotal?: number;
      }>;
    };
    result: { nftIds: string[] };
  };

  // ─── Loroco read-only extensions (WC-bypass surface) ─────────────────────
  // These mirror endpoints from the upstream Sage API (vendor/sage/.../endpoints/*)
  // that DON'T require new Rust work — they're served straight from the
  // JS-side coin-store (chrome.storage.local["coins.<fp>"]) so any dApp
  // hitting `chia_*` / `chip0002_*` / snake_case gets WC-compatible reads
  // without us shipping a new WASM build.

  /** List coins of an asset type (XCH/CAT/NFT), paginated. Includes spent flag. */
  getCoins: {
    params:
      | {
          type?: AssetType;
          assetId?: Hex | null;
          limit?: number;
          offset?: number;
          /** Default: false — only return unspent coins. */
          includeSpent?: boolean;
        }
      | undefined;
    result: CoinView[];
  };

  /** Resolve coins by their coin_id. Unknown ids are silently omitted. */
  getCoinsByIds: {
    params: { coinIds: Hex[] };
    result: CoinView[];
  };

  /**
   * Does the wallet own at least one unspent coin for this asset?
   * `type` selects which bucket to look in (cat / nft / did).
   */
  isAssetOwned: {
    params: { type: "cat" | "did" | "nft"; assetId: Hex };
    result: boolean;
  };

  /** Owned CAT assets (asset_id + unspent totals). */
  getCats: {
    params: { limit?: number; offset?: number } | undefined;
    result: CatAssetView[];
  };

  /** Alias of `getCats` — Sage WC2 name. Returns the same shape. */
  getAllCats: {
    params: { limit?: number; offset?: number } | undefined;
    result: CatAssetView[];
  };

  /** Lookup a single CAT asset by id. Null when the wallet doesn't track it. */
  getToken: {
    params: { assetId: Hex };
    result: CatAssetView | null;
  };

  /**
   * Derived addresses for the active wallet. Hardened branch requires an
   * unlocked wallet (master SK access); unhardened is served from cached
   * `master_public_key`.
   */
  getDerivations: {
    params:
      | { offset?: number; limit?: number; hardened?: boolean }
      | undefined;
    result: Derivation[];
  };

  /**
   * Flat tx history derived from coin observations + mempool snapshot.
   * One entry per (coin_id, direction) pair. Pending entries carry the
   * mempool tx_id; confirmed entries fall back to the coin_id as id.
   */
  getTransactions: {
    params: { limit?: number; offset?: number; pendingOnly?: boolean } | undefined;
    result: TransactionView[];
  };

  /** Convenience filter for `getTransactions({ pendingOnly: true })`. */
  getPendingTransactions: {
    params: void | undefined;
    result: TransactionView[];
  };

  /** Offers persisted in `offers.<fp>` after createOffer/takeOffer. */
  getOffers: {
    params: { limit?: number; offset?: number; includeCancelled?: boolean } | undefined;
    result: OfferView[];
  };

  /** Single offer by id. Null when unknown. */
  getOffer: {
    params: { id: Hex };
    result: OfferView | null;
  };

  // ─── Oleada 2 — multi-output write surface ───────────────────────────────
  // These map onto the multi-output `send_xch` / `send_cat` WASM endpoints.
  // Result is the same TransactionResp shape as `transfer` so dApps can treat
  // them uniformly: { id } when broadcast succeeds.

  /** Send XCH to N recipients in a single SpendBundle. */
  bulkSendXch: {
    params: {
      outputs: Array<{ address: string; amount: Amount }>;
      fee?: Amount;
    };
    result: { id: Hex } | Record<string, never>;
  };

  /** Send a single CAT to N recipients in a single SpendBundle. */
  bulkSendCat: {
    params: {
      assetId: Hex;
      outputs: Array<{ address: string; amount: Amount }>;
      fee?: Amount;
    };
    result: { id: Hex } | Record<string, never>;
  };

  /**
   * Consolidate many small XCH coins into one (self-send). All inputs from
   * the wallet's own derived puzzle hashes are eligible; pick the N largest
   * up to `maxInputs` (default 10). Output goes back to a fresh derived address.
   */
  combine: {
    params: { maxInputs?: number; fee?: Amount };
    result: { id: Hex } | Record<string, never>;
  };

  /**
   * Split a large XCH coin into N equal self-send outputs. Pick the largest
   * unspent coin as the input; `parts` (default 2) determines how many
   * outputs the resulting bundle creates.
   */
  split: {
    params: { parts: number; fee?: Amount };
    result: { id: Hex } | Record<string, never>;
  };

  // ─── Oleada 3 — new on-chain primitives ──────────────────────────────────
  // Each one introduces a new chia_wallet_sdk driver call on the Rust side
  // (issue_cat / create_did) and a TS handler that auto-picks an XCH input
  // from the coin-store.

  /**
   * Issue a brand-new CAT using a single-issuance TAIL (GenesisByCoinId).
   * The TAIL is derived from the XCH coin used as the genesis parent, so
   * each emission is unique and unrepeatable. Returns the resulting
   * asset_id so the dApp can immediately reference the new CAT.
   */
  issueCat: {
    params: {
      /** Bech32m XCH address that will own the initial CAT supply. */
      recipientAddress: string;
      /** Initial CAT supply, in CAT mojos (1 CAT = 1000 CAT mojos). */
      amount: Amount;
      fee?: Amount;
    };
    result: { id: Hex; assetId: Hex };
  };

  /**
   * Create a new DID singleton owned by the wallet's own p2 puzzle. Uses
   * the simple-DID profile (no recovery list, 1 verification, NIL metadata).
   * Returns the launcher_id (also surfaced as `didId`).
   */
  createDid: {
    params: {
      fee?: Amount;
    };
    result: { id: Hex; didId: Hex };
  };

  /**
   * Append a new URI to one of an NFT's metadata lists. Re-spends the NFT
   * to its current owner — only metadata changes. The wallet must own the
   * NFT's p2 inner puzzle (verified server-side via derivationIndex).
   *
   * uriKind selects which list the URI joins:
   *   "data"     → primary data_uris (image / file)
   *   "metadata" → metadata_uris (off-chain attributes)
   *   "license"  → license_uris (rights / terms)
   *
   * Caller may pass either the NFT's launcher_id OR coin_id; the handler
   * resolves to the current head coin via the local NFT store.
   */
  addNftUri: {
    params: {
      /** Either launcherId OR coinId is required. */
      launcherId?: Hex;
      coinId?: Hex;
      uriKind: "data" | "metadata" | "license";
      uri: string;
      fee?: Amount;
    };
    result: { id: Hex; launcherId: Hex };
  };

  // ─── Stub reads — silence WC2 dApp probes until full implementations land ─
  // dApps that target Sage's WC API frequently call these on connect to
  // populate UI dropdowns. Returning 4004 makes them show "wallet doesn't
  // support DIDs" errors; returning empty arrays / null lets the UI render
  // gracefully and the wallet still works for non-DID flows.
  //
  // Real implementations require JS-side DID sync (Fase 3). When that lands
  // these handlers will route to actual coin-store reads instead of stubs.

  /** DIDs owned by the wallet. Empty stub until Fase 3 DID sync. */
  getDids: {
    params: { limit?: number; offset?: number } | undefined;
    result: DidInfo[];
  };

  /** NFT collections derived from owned NFTs' minter DIDs. Stub today. */
  getNftCollections: {
    params: { limit?: number; offset?: number } | undefined;
    result: NftCollectionInfo[];
  };

  /** Single collection lookup. Always null until Fase 3. */
  getNftCollection: {
    params: { collectionId: Hex };
    result: NftCollectionInfo | null;
  };

  /** Minter DIDs across the wallet's NFTs. Empty stub today. */
  getMinterDidIds: {
    params: { limit?: number; offset?: number } | undefined;
    result: Hex[];
  };

  /**
   * Transfer ownership of a DID to a new p2 owner. Caller passes the
   * DID's current head coin id + the derivation_index of the wallet
   * key that currently owns it; the engine refetches the parent spend,
   * reconstructs the singleton, and emits a re-spend to the recipient.
   *
   * Until Fase 3 lands JS-side DID tracking, the dApp must supply
   * `didCoinId` + `didDerivationIndex` directly (same constraint as
   * bulkMintNfts). When DID sync is wired we'll resolve from `didId`
   * (launcher_id) alone.
   */
  transferDid: {
    params: {
      didCoinId: Hex;
      didDerivationIndex: number;
      recipientAddress: string;
      fee?: Amount;
    };
    result: { id: Hex; launcherId: Hex };
  };

  /**
   * Normalize one or more DIDs to the "simple" profile:
   *   recovery_list_hash = empty-list hash
   *   num_verifications_required = 1
   * Metadata + owner stay the same. Useful when a DID was created with
   * a non-standard recovery list and the user wants to reset it.
   *
   * One bundle per DID — the handler iterates `didCoinIds` so each DID
   * gets its own tx. Returns one entry per DID. Fee is applied to the
   * FIRST tx only; subsequent normalizations don't carry an XCH fee.
   *
   * Until Fase 3 DID sync lands, the caller must supply each DID's
   * current head coin id and the wallet derivation_index that owns its
   * p2 puzzle.
   */
  normalizeDids: {
    params: {
      /** Parallel arrays — entry i targets didCoinIds[i] / didDerivationIndices[i]. */
      didCoinIds: Hex[];
      didDerivationIndices: number[];
      fee?: Amount;
    };
    result: Array<{ id: Hex; launcherId: Hex }>;
  };
}

// ─── Stub view types (filled in by Fase 3 DID sync) ──────────────────────

export interface DidInfo {
  launcherId: Hex;
  coinId: Hex;
  /** bech32m did:chia: address. */
  address: string;
  /** Off-chain display name from the DID's metadata, when present. */
  name: string | null;
}

export interface NftCollectionInfo {
  collectionId: Hex;
  name: string | null;
  /** Minter DID launcher id when known. */
  minterDid: Hex | null;
  /** Count of NFTs we own from this collection. */
  count: number;
}

// ─── View types for Loroco read extensions ─────────────────────────────────

/** Flattened on-chain coin view served from the JS coin-store. */
export interface CoinView {
  coinId: Hex;
  parentCoinInfo: Hex;
  puzzleHash: Hex;
  /** mojos as a string — XCH coins can exceed 2^53. */
  amount: string;
  confirmedBlockIndex: number;
  spent: boolean;
  spentBlockIndex: number;
  /** "xch" | "cat" | "nft". DIDs surface here once Fase 3 lands. */
  assetType: "xch" | "cat" | "nft";
  /** asset_id for CAT, launcher_id for NFT, null for XCH. */
  assetId: Hex | null;
  /** Optimistic-spent marker (broadcast but not yet confirmed). */
  pending?: boolean;
}

/** CAT asset summary — what `chia_getCats` / `getToken` return. */
export interface CatAssetView {
  assetId: Hex;
  /** unspent mojos as a string. */
  balance: string;
  /** unspent coin count. */
  coinCount: number;
  /** Optional metadata. Empty until a metadata source (Dexie/Spacescan) is wired. */
  name?: string | null;
  symbol?: string | null;
  iconUrl?: string | null;
}

/** Derived address row — matches `derive_addresses` engine response shape. */
export interface Derivation {
  index: number;
  hardened: boolean;
  publicKey: Hex;
  address: string;
  puzzleHash: Hex;
}

/** One row in the dApp-facing tx history. */
export interface TransactionView {
  /** mempool tx_id for pending, coin_id for confirmed. */
  id: Hex;
  direction: "incoming" | "outgoing";
  status: "pending" | "confirmed";
  /** Confirmed block height, null when pending. */
  height: number | null;
  /** ms epoch when the coin was created/spent. null when unknown. */
  timestamp: number | null;
  asset: { type: "xch" | "cat"; assetId: Hex | null };
  /** Coin amount in mojos as a string. */
  amount: string;
}

/** Offer summary persisted in `offers.<fp>`. */
export interface OfferView {
  id: Hex;
  offer: string;
  /** Local-cancel marker (secure=false) or post-on-chain-cancel marker. */
  cancelled: boolean;
  /** When this offer was created/taken (ms epoch). 0 when not tracked. */
  createdAt: number;
}

/**
 * Sage WC2 NFT shape — camelCase, nullable fields. Returned when the dApp
 * invoked `chia_getNfts` (vs the Loroco/Goby `getNFTs` which returns
 * snake_case NftInfo). Mirrors `vendor/sage/src/walletconnect/commands.ts:nft`.
 */
export interface NftWcInfo {
  name: string | null;
  launcherId: Hex;
  collectionId: string | null;
  collectionName: string | null;
  minterDid: Hex | null;
  ownerDid: Hex | null;
  createdHeight: number | null;
  coinId: Hex;
  address: string;
  royaltyAddress: string;
  royaltyTenThousandths: number;
  dataUris: string[];
  dataHash: Hex | null;
  metadataUris: string[];
  metadataHash: Hex | null;
  licenseUris: string[];
  licenseHash: Hex | null;
  editionNumber: number | null;
  editionTotal: number | null;
}

export type ChiaMethod = keyof ChiaMethodMap;

export interface RequestArguments<M extends ChiaMethod = ChiaMethod> {
  method: M;
  params?: ChiaMethodMap[M]["params"];
}

export type ChiaEvent = "chainChanged" | "accountChanged";

export interface ChiaWallet {
  // Identity
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly isGoby: true;
  readonly isLoroco?: true;
  /** @deprecated legacy alias kept for the rebrand period. Prefer isLoroco. */
  readonly isOzone?: true;

  // Transport
  request<M extends ChiaMethod>(args: RequestArguments<M>): Promise<ChiaMethodMap[M]["result"]>;

  // Goby-legacy direct methods. dApps built against Goby's pre-CHIP-0002
  // surface call these instead of `request({method:'...'})`. Required for
  // dexie.space, tibetswap and other integrations that don't use the
  // `request()` form.
  connect(params?: ChiaMethodMap["connect"]["params"]): Promise<ChiaMethodMap["connect"]["result"]>;
  walletSwitchChain(
    params: ChiaMethodMap["walletSwitchChain"]["params"],
  ): Promise<ChiaMethodMap["walletSwitchChain"]["result"]>;
  walletWatchAsset(
    params: ChiaMethodMap["walletWatchAsset"]["params"],
  ): Promise<ChiaMethodMap["walletWatchAsset"]["result"]>;
  getPublicKeys(
    params?: ChiaMethodMap["getPublicKeys"]["params"],
  ): Promise<ChiaMethodMap["getPublicKeys"]["result"]>;
  filterUnlockedCoins(
    params: ChiaMethodMap["filterUnlockedCoins"]["params"],
  ): Promise<ChiaMethodMap["filterUnlockedCoins"]["result"]>;
  getAssetCoins(
    params: ChiaMethodMap["getAssetCoins"]["params"],
  ): Promise<ChiaMethodMap["getAssetCoins"]["result"]>;
  getAssetBalance(
    params: ChiaMethodMap["getAssetBalance"]["params"],
  ): Promise<ChiaMethodMap["getAssetBalance"]["result"]>;
  signCoinSpends(
    params: ChiaMethodMap["signCoinSpends"]["params"],
  ): Promise<ChiaMethodMap["signCoinSpends"]["result"]>;
  signMessage(
    params: ChiaMethodMap["signMessage"]["params"],
  ): Promise<ChiaMethodMap["signMessage"]["result"]>;
  transfer(
    params: ChiaMethodMap["transfer"]["params"],
  ): Promise<ChiaMethodMap["transfer"]["result"]>;
  sendTransaction(
    params: ChiaMethodMap["sendTransaction"]["params"],
  ): Promise<ChiaMethodMap["sendTransaction"]["result"]>;
  createOffer(
    params: ChiaMethodMap["createOffer"]["params"],
  ): Promise<ChiaMethodMap["createOffer"]["result"]>;
  takeOffer(
    params: ChiaMethodMap["takeOffer"]["params"],
  ): Promise<ChiaMethodMap["takeOffer"]["result"]>;
  signMessageByAddress(
    params: ChiaMethodMap["signMessageByAddress"]["params"],
  ): Promise<ChiaMethodMap["signMessageByAddress"]["result"]>;
  getNFTs(
    params?: ChiaMethodMap["getNFTs"]["params"],
  ): Promise<ChiaMethodMap["getNFTs"]["result"]>;
  getNFTInfo(
    params: ChiaMethodMap["getNFTInfo"]["params"],
  ): Promise<ChiaMethodMap["getNFTInfo"]["result"]>;
  cancelOffer(
    params: ChiaMethodMap["cancelOffer"]["params"],
  ): Promise<ChiaMethodMap["cancelOffer"]["result"]>;

  // Events
  on(event: ChiaEvent, listener: (...args: any[]) => void): void;
  off?(event: ChiaEvent, listener: (...args: any[]) => void): void;
  removeListener?(event: ChiaEvent, listener: (...args: any[]) => void): void;

  // Optional accessors
  readonly chainId?: ChainId;
  readonly selectedAddress?: string;
  isConnected?(): boolean;
}

declare global {
  interface Window {
    chia?: ChiaWallet;
    loroco?: ChiaWallet;
    /** @deprecated legacy alias kept during the rebrand. Use `window.loroco`. */
    ozone?: ChiaWallet;
  }
}

// ─── Wire envelope (page <-> content <-> background) ─────────────────────────

export const PAGE_TARGET = "loroco-inpage" as const;
export const CONTENT_TARGET = "loroco-content" as const;

export interface PageRequestMessage<M extends ChiaMethod = ChiaMethod> {
  target: typeof CONTENT_TARGET;
  id: number;
  origin: string;
  method: M;
  params?: ChiaMethodMap[M]["params"];
}

export interface PageResponseMessage<M extends ChiaMethod = ChiaMethod> {
  target: typeof PAGE_TARGET;
  id: number;
  result?: ChiaMethodMap[M]["result"];
  error?: { code: number; message: string; data?: unknown };
}

export interface PageEventMessage {
  target: typeof PAGE_TARGET;
  event: ChiaEvent;
  payload: unknown;
}

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

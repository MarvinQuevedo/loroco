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
  transfer: {
    params: {
      to: string;
      amount: Amount;
      assetId: Hex | "" | null;
      memos?: Hex[];
      fee?: Amount;
    };
    result: { id: Hex };
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

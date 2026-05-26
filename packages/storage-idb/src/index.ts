// IndexedDB-backed storage for the Sage WASM module.
// Exposed as a callback object that wasm-bindgen will consume (JsCallbackStorage trait).

import { openDB, type IDBPDatabase } from "idb";
import {
  type CoinRow,
  type DerivationRow,
  type DidRow,
  type NftRow,
  type OfferRow,
  type OzoneDb,
  SCHEMA_VERSION,
  type TxRow,
} from "./schema.js";

export class IdbStorage {
  private constructor(private readonly db: IDBPDatabase<OzoneDb>) {}

  static async open(walletId: string): Promise<IdbStorage> {
    const db = await openDB<OzoneDb>(`ozone-wallet-${walletId}`, SCHEMA_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const coins = db.createObjectStore("coins", { keyPath: "coinId" });
          coins.createIndex("by_puzzle_hash", "puzzleHash");
          coins.createIndex("by_hint", "hint");
          coins.createIndex("by_asset_id", "assetId");
          coins.createIndex("by_spent", "spentBlockIndex");

          const derivations = db.createObjectStore("derivations", {
            keyPath: ["walletId", "index", "hardened"],
          });
          derivations.createIndex("by_puzzle_hash", "puzzleHash");
          derivations.createIndex("by_pubkey", "pubkey");

          const txs = db.createObjectStore("txs", { keyPath: "txId" });
          txs.createIndex("by_status", "status");

          const nfts = db.createObjectStore("nfts", { keyPath: "launcherId" });
          nfts.createIndex("by_owner", "ownerDid");

          db.createObjectStore("dids", { keyPath: "launcherId" });

          const offers = db.createObjectStore("offers", { keyPath: "offerId" });
          offers.createIndex("by_status", "status");

          db.createObjectStore("kv", { keyPath: "key" });
        }
      },
    });
    return new IdbStorage(db);
  }

  // ─── Coins ──────────────────────────────────────────────────────────────
  async upsertCoin(row: CoinRow) {
    await this.db.put("coins", row);
  }
  async getCoin(coinId: string): Promise<CoinRow | undefined> {
    return this.db.get("coins", coinId);
  }
  async coinsByPuzzleHash(ph: string): Promise<CoinRow[]> {
    return this.db.getAllFromIndex("coins", "by_puzzle_hash", ph);
  }
  async coinsByHint(hint: string): Promise<CoinRow[]> {
    return this.db.getAllFromIndex("coins", "by_hint", hint);
  }
  async unspentCoins(): Promise<CoinRow[]> {
    return this.db.getAllFromIndex("coins", "by_spent", 0);
  }
  async markSpent(coinId: string, height: number) {
    const tx = this.db.transaction("coins", "readwrite");
    const cur = await tx.store.get(coinId);
    if (cur) {
      cur.spentBlockIndex = height;
      await tx.store.put(cur);
    }
    await tx.done;
  }

  // ─── Derivations ────────────────────────────────────────────────────────
  async putDerivation(row: DerivationRow) {
    await this.db.put("derivations", row);
  }
  async derivationByPuzzleHash(ph: string): Promise<DerivationRow | undefined> {
    return this.db.getFromIndex("derivations", "by_puzzle_hash", ph);
  }

  // ─── Txs ────────────────────────────────────────────────────────────────
  async putTx(row: TxRow) {
    await this.db.put("txs", row);
  }
  async pendingTxs(): Promise<TxRow[]> {
    return this.db.getAllFromIndex("txs", "by_status", "pending");
  }

  // ─── NFTs / DIDs / Offers ───────────────────────────────────────────────
  async putNft(row: NftRow) {
    await this.db.put("nfts", row);
  }
  async putDid(row: DidRow) {
    await this.db.put("dids", row);
  }
  async putOffer(row: OfferRow) {
    await this.db.put("offers", row);
  }

  // ─── KV ─────────────────────────────────────────────────────────────────
  async kvGet<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.db.get("kv", key);
    return row?.value as T | undefined;
  }
  async kvSet(key: string, value: unknown) {
    await this.db.put("kv", { key, value });
  }

  // ─── Bridge for wasm-bindgen JsCallbackStorage ─────────────────────────
  /**
   * Returns an object whose methods match the JsCallbackStorage trait in sage-wasm.
   * Pass the result to `new Sage(callbacks)` from the WASM module.
   */
  asWasmCallbacks() {
    return {
      upsertCoin: (json: string) => this.upsertCoin(JSON.parse(json) as CoinRow),
      getCoin: async (coinId: string) => JSON.stringify((await this.getCoin(coinId)) ?? null),
      coinsByPuzzleHash: async (ph: string) => JSON.stringify(await this.coinsByPuzzleHash(ph)),
      coinsByHint: async (hint: string) => JSON.stringify(await this.coinsByHint(hint)),
      unspentCoins: async () => JSON.stringify(await this.unspentCoins()),
      markSpent: (coinId: string, height: number) => this.markSpent(coinId, height),

      putDerivation: (json: string) => this.putDerivation(JSON.parse(json) as DerivationRow),
      derivationByPuzzleHash: async (ph: string) =>
        JSON.stringify((await this.derivationByPuzzleHash(ph)) ?? null),

      putTx: (json: string) => this.putTx(JSON.parse(json) as TxRow),
      pendingTxs: async () => JSON.stringify(await this.pendingTxs()),

      putNft: (json: string) => this.putNft(JSON.parse(json) as NftRow),
      putDid: (json: string) => this.putDid(JSON.parse(json) as DidRow),
      putOffer: (json: string) => this.putOffer(JSON.parse(json) as OfferRow),

      kvGet: async (key: string) => JSON.stringify((await this.kvGet(key)) ?? null),
      kvSet: (key: string, valueJson: string) => this.kvSet(key, JSON.parse(valueJson)),
    };
  }
}

export type {
  CoinRow,
  DerivationRow,
  TxRow,
  NftRow,
  DidRow,
  OfferRow,
} from "./schema.js";

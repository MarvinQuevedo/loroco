// IndexedDB schema for an Ozone wallet.
// One database per fingerprint (so multiple wallets coexist).

import type { DBSchema } from "idb";

export const SCHEMA_VERSION = 1;

export interface CoinRow {
  coinId: string;           // hex 0x... (primary key)
  parentCoinInfo: string;
  puzzleHash: string;
  amount: string;           // u64 as decimal string
  confirmedBlockIndex: number;
  spentBlockIndex: number;  // 0 = unspent
  coinbase: boolean;
  hint?: string;
  type: "xch" | "cat" | "nft" | "did" | "unknown";
  assetId?: string;         // CAT tail / NFT launcher / DID launcher
  locked: boolean;
  timestamp?: number;
}

export interface DerivationRow {
  walletId: string;
  index: number;
  hardened: boolean;
  pubkey: string;
  puzzleHash: string;
  address: string;
}

export interface TxRow {
  txId: string;             // spend bundle name
  status: "pending" | "in_mempool" | "confirmed" | "failed" | "dropped";
  spendBundle: string;      // serialized json
  submittedAt: number;
  confirmedHeight?: number;
  failReason?: string;
}

export interface NftRow {
  launcherId: string;
  metadataUris: string[];
  metadataHash?: string;
  dataUris: string[];
  dataHash?: string;
  licenseUris: string[];
  licenseHash?: string;
  ownerDid?: string;
  royaltyAddress?: string;
  royaltyTenThousandths?: number;
  currentCoinId: string;
  editionNumber?: number;
  editionTotal?: number;
}

export interface DidRow {
  launcherId: string;
  metadata: string;         // serialized
  recoveryList: string[];
  numVerificationsRequired: number;
  currentCoinId: string;
}

export interface OfferRow {
  offerId: string;
  status: "pending" | "active" | "cancelled" | "taken" | "expired";
  encoded: string;          // bech32m offer string
  offered: string;          // serialized AssetAmount[]
  requested: string;        // serialized AssetAmount[]
  createdAt: number;
}

export interface KvRow {
  key: string;
  value: unknown;
}

export interface OzoneDb extends DBSchema {
  coins: {
    key: string;
    value: CoinRow;
    indexes: {
      by_puzzle_hash: string;
      by_hint: string;
      by_asset_id: string;
      by_spent: number;
    };
  };
  derivations: {
    key: [string, number, number]; // [walletId, index, hardened(0|1)]
    value: DerivationRow;
    indexes: {
      by_puzzle_hash: string;
      by_pubkey: string;
    };
  };
  txs: {
    key: string;
    value: TxRow;
    indexes: { by_status: string };
  };
  nfts: {
    key: string;
    value: NftRow;
    indexes: { by_owner: string };
  };
  dids: {
    key: string;
    value: DidRow;
  };
  offers: {
    key: string;
    value: OfferRow;
    indexes: { by_status: string };
  };
  kv: {
    key: string;
    value: KvRow;
  };
}

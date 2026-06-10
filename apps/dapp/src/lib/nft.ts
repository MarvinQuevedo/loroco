// NFT shape adapter.
//
// getNFTs has a DUAL result shape (CLAUDE.md gotcha #3):
//   • Loroco/Goby  → NftInfo[]            (snake_case: launcher_id, data_uris)
//   • chia_getNfts → { nfts: NftWcInfo[] } (camelCase: launcherId, dataUris)
// Normalize both into one render-friendly shape so features never branch.

import type { NftInfo, NftWcInfo } from "@ozone/goby-provider/types";

export interface NormalizedNft {
  launcherId: string;
  coinId: string | null;
  name: string | null;
  ownerDid: string | null;
  royaltyAddress: string | null;
  /** royalty as a fraction of 10000 (basis points / 100). */
  royaltyTenThousandths: number | null;
  dataUris: string[];
  dataHash: string | null;
  metadataUris: string[];
  metadataHash: string | null;
  licenseUris: string[];
  licenseHash: string | null;
  editionNumber: number | null;
  editionTotal: number | null;
  /** Best image URI for thumbnails. */
  image: string | null;
}

function isWc(n: NftInfo | NftWcInfo): n is NftWcInfo {
  return "launcherId" in n;
}

export function normalizeNft(n: NftInfo | NftWcInfo): NormalizedNft {
  if (isWc(n)) {
    return {
      launcherId: n.launcherId,
      coinId: n.coinId ?? null,
      name: n.name ?? null,
      ownerDid: n.ownerDid ?? null,
      royaltyAddress: n.royaltyAddress ?? null,
      royaltyTenThousandths: n.royaltyTenThousandths ?? null,
      dataUris: n.dataUris ?? [],
      dataHash: n.dataHash ?? null,
      metadataUris: n.metadataUris ?? [],
      metadataHash: n.metadataHash ?? null,
      licenseUris: n.licenseUris ?? [],
      licenseHash: n.licenseHash ?? null,
      editionNumber: n.editionNumber ?? null,
      editionTotal: n.editionTotal ?? null,
      image: n.dataUris?.[0] ?? null,
    };
  }
  const royaltyPct = n.royalty_percentage;
  return {
    launcherId: n.launcher_id,
    coinId: n.nft_coin_id ?? null,
    name: null, // snake_case NftInfo carries no display name
    ownerDid: n.owner_did ?? null,
    royaltyAddress: n.royalty_address ?? null,
    royaltyTenThousandths: royaltyPct == null ? null : Math.round(royaltyPct * 100),
    dataUris: n.data_uris ?? [],
    dataHash: n.data_hash ?? null,
    metadataUris: n.metadata_uris ?? [],
    metadataHash: n.metadata_hash ?? null,
    licenseUris: n.license_uris ?? [],
    licenseHash: n.license_hash ?? null,
    editionNumber: n.edition_number ?? null,
    editionTotal: n.edition_total ?? null,
    image: n.data_uris?.[0] ?? null,
  };
}

/** Normalize the whole getNFTs result regardless of which shape came back. */
export function normalizeNftsResult(result: NftInfo[] | { nfts: NftWcInfo[] }): NormalizedNft[] {
  const list = Array.isArray(result) ? result : result.nfts;
  return (list ?? []).map(normalizeNft);
}

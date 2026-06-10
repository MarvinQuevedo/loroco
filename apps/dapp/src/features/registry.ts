// Single source of truth for the feature sections. Drives the sidebar nav
// and (for now) the per-feature placeholder method lists. When the real
// feature UIs land they keep this metadata for headers/coverage.

export type MethodClass =
  | "read" // NO_APPROVAL_METHODS — no popup after connect
  | "write" // ALWAYS_APPROVAL_METHODS — per-call popup
  | "wallet" // popup-only, returns 4004 to dApps (combine/split/normalizeDids)
  | "stub"; // empty until Fase 3 (collections / minter DIDs)

export interface FeatureMethod {
  name: string;
  cls: MethodClass;
}

export interface FeatureMeta {
  path: string;
  title: string;
  icon: string;
  blurb: string;
  methods: FeatureMethod[];
}

export const FEATURES: FeatureMeta[] = [
  {
    path: "/",
    title: "Dashboard",
    icon: "📊",
    blurb: "Balance, network, address and at-a-glance counts.",
    methods: [
      { name: "chainId", cls: "read" },
      { name: "accounts", cls: "read" },
      { name: "getAddress", cls: "read" },
      { name: "getAssetBalance", cls: "read" },
      { name: "getCats", cls: "read" },
      { name: "getNFTs", cls: "read" },
      { name: "getOffers", cls: "read" },
      { name: "getDids", cls: "read" },
      { name: "getDerivations", cls: "read" },
      { name: "getPublicKeys", cls: "read" },
      { name: "walletSwitchChain", cls: "write" },
    ],
  },
  {
    path: "/send",
    title: "Send",
    icon: "📤",
    blurb: "Single XCH or CAT transfer.",
    methods: [{ name: "transfer", cls: "write" }],
  },
  {
    path: "/batch",
    title: "Batch",
    icon: "📦",
    blurb: "Multi-recipient sends and atomic XCH+CAT bundles.",
    methods: [
      { name: "bulkSendXch", cls: "write" },
      { name: "bulkSendCat", cls: "write" },
      { name: "multiSend", cls: "write" },
      { name: "combine", cls: "wallet" },
      { name: "split", cls: "wallet" },
    ],
  },
  {
    path: "/tokens",
    title: "Tokens",
    icon: "🪙",
    blurb: "CAT balances, lookup, issuance and watch.",
    methods: [
      { name: "getCats", cls: "read" },
      { name: "getAllCats", cls: "read" },
      { name: "getToken", cls: "read" },
      { name: "issueCat", cls: "write" },
      { name: "walletWatchAsset", cls: "write" },
    ],
  },
  {
    path: "/nfts",
    title: "NFTs",
    icon: "🖼️",
    blurb: "Owned NFTs, lookup, bulk mint and URI append.",
    methods: [
      { name: "getNFTs", cls: "read" },
      { name: "getNFTInfo", cls: "read" },
      { name: "bulkMintNfts", cls: "write" },
      { name: "addNftUri", cls: "write" },
    ],
  },
  {
    path: "/offers",
    title: "Offers",
    icon: "🤝",
    blurb: "Create, take, list and cancel offers.",
    methods: [
      { name: "createOffer", cls: "write" },
      { name: "takeOffer", cls: "write" },
      { name: "getOffers", cls: "read" },
      { name: "getOffer", cls: "read" },
      { name: "cancelOffer", cls: "write" },
    ],
  },
  {
    path: "/dids",
    title: "DIDs",
    icon: "🪪",
    blurb: "Decentralized IDs minted by this wallet.",
    methods: [
      { name: "getDids", cls: "read" },
      { name: "createDid", cls: "write" },
      { name: "transferDid", cls: "write" },
      { name: "normalizeDids", cls: "wallet" },
      { name: "getNftCollections", cls: "stub" },
      { name: "getNftCollection", cls: "stub" },
      { name: "getMinterDidIds", cls: "stub" },
    ],
  },
  {
    path: "/coins",
    title: "Coins",
    icon: "🔎",
    blurb: "Coin explorer and client-side balance analysis.",
    methods: [
      { name: "getCoins", cls: "read" },
      { name: "getCoinsByIds", cls: "read" },
      { name: "getAssetCoins", cls: "read" },
      { name: "getAssetBalance", cls: "read" },
      { name: "filterUnlockedCoins", cls: "read" },
      { name: "isAssetOwned", cls: "read" },
    ],
  },
  {
    path: "/activity",
    title: "Activity",
    icon: "📜",
    blurb: "Transaction history, incoming/outgoing, pending.",
    methods: [
      { name: "getTransactions", cls: "read" },
      { name: "getPendingTransactions", cls: "read" },
    ],
  },
  {
    path: "/signing",
    title: "Signing",
    icon: "✍️",
    blurb: "Sign arbitrary messages by public key or address.",
    methods: [
      { name: "signMessage", cls: "write" },
      { name: "signMessageByAddress", cls: "write" },
    ],
  },
  {
    path: "/advanced",
    title: "Advanced",
    icon: "🧪",
    blurb: "Raw method console + blind-sign primitives.",
    methods: [
      { name: "signCoinSpends", cls: "write" },
      { name: "sendTransaction", cls: "write" },
    ],
  },
];

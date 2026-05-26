// Persistent wallet metadata, stored across browser sessions.
//
// chrome.storage.local: { wallets: { [fingerprint]: { keychainBlob, label } } }
// chrome.storage.session: { walletId: string, fingerprint: number }
//
// "walletId" is the IndexedDB database key (we use the fingerprint as a
// string so each wallet's coin data lives in its own DB).

export interface StoredWallet {
  fingerprint: number;
  keychainBlob: string; // hex
  masterPublicKey?: string; // hex, 0x-prefixed — enables sync without unlock
  label: string;
  createdAt: number;
}

const LOCAL_KEY = "wallets";
const SESSION_FINGERPRINT = "activeFingerprint";
const SESSION_TAB = "activeTab";

interface WalletMap {
  [fingerprint: string]: StoredWallet;
}

async function loadAll(): Promise<WalletMap> {
  const data = await chrome.storage.local.get(LOCAL_KEY);
  return (data[LOCAL_KEY] as WalletMap | undefined) ?? {};
}

async function saveAll(wallets: WalletMap): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEY]: wallets });
}

export async function listWallets(): Promise<StoredWallet[]> {
  const map = await loadAll();
  return Object.values(map).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getWallet(fingerprint: number): Promise<StoredWallet | undefined> {
  const map = await loadAll();
  return map[fingerprint.toString()];
}

export async function saveWallet(wallet: StoredWallet): Promise<void> {
  const map = await loadAll();
  map[wallet.fingerprint.toString()] = wallet;
  await saveAll(map);
}

export async function removeWallet(fingerprint: number): Promise<void> {
  const map = await loadAll();
  delete map[fingerprint.toString()];
  await saveAll(map);
}

export async function getActiveFingerprint(): Promise<number | null> {
  const data = await chrome.storage.session.get(SESSION_FINGERPRINT);
  const fp = data[SESSION_FINGERPRINT];
  return typeof fp === "number" ? fp : null;
}

export async function setActiveFingerprint(fingerprint: number | null): Promise<void> {
  if (fingerprint === null) {
    await chrome.storage.session.remove(SESSION_FINGERPRINT);
  } else {
    await chrome.storage.session.set({ [SESSION_FINGERPRINT]: fingerprint });
  }
}

export async function getActiveTab(): Promise<string | null> {
  const data = await chrome.storage.session.get(SESSION_TAB);
  const t = data[SESSION_TAB];
  return typeof t === "string" ? t : null;
}

export async function setActiveTab(tab: string): Promise<void> {
  await chrome.storage.session.set({ [SESSION_TAB]: tab });
}

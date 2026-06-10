# Plan — Loroco dApp Console (`loroco.marvinquevedo.com`)

> dApp web completa que ejercita **todo** el potencial del provider `window.chia`
> de Loroco: crear/tomar/cancelar ofertas, mintear NFTs y CATs, envíos en batch,
> análisis de coins, ver/crear/administrar DIDs, firmar, e historial.
> Es un **cliente** del wallet — el wallet sigue siendo la autoridad de seguridad
> (cada método mutante re-aprueba en el popup). Esta dApp NO toca el código del
> wallet ni sus invariantes de seguridad.

Estado: **PLAN aprobado para construir luego.** Rama de trabajo: `feat/dapp-console`.

---

## 0. Decisiones ya tomadas (no re-preguntar)

| Decisión   | Elección                                                            |
|------------|---------------------------------------------------------------------|
| Hosting    | **Vercel** (custom domain `loroco.marvinquevedo.com`, CNAME a Vercel) |
| Stack      | **React 19 + Vite + TypeScript** (build)                            |
| Ubicación  | **Workspace `apps/dapp`** dentro del monorepo pnpm                  |
| Routing    | **HashRouter** (evita 404 en refresh sin rewrites de servidor)     |
| Tipos      | `import type` desde `@ozone/goby-provider/types` (type-only, se borra en build) |

Node 22 / pnpm 10.32.1. React 19.0.0, react-router-dom ^7.1.0 (igual que la extensión).

---

## 1. Modelo mental: qué expone el wallet

47 métodos. La dApp solo hace `provider.request({ method, params })`.
El provider se inyecta en `window.loroco` (siempre), `window.chia` y `window.ozone` (compat).

**Gating (de `permissions.ts`):**
- `connect` / `requestAccounts` = única puerta de entrada. **Todo** lo demás
  (incluso reads) exige un grant de conexión previo.
- READ (`NO_APPROVAL_METHODS`, 24): no popup tras conectar.
- MUTANTES (`ALWAYS_APPROVAL_METHODS`, 23): popup por-llamada, siempre.
- **POPUP-ONLY** (devuelven `4004` a dApps, NO accionables desde web):
  `combine`, `split`, `normalizeDids` → mostrarlos como "solo wallet", informativos.
- **STUBS** (devuelven vacío hasta Fase 3): `getNftCollections`, `getNftCollection`,
  `getMinterDidIds` → mostrar pero etiquetar "Fase 3".

**Errores:** `e.code` (4000 invalid, 4001 unauthorized, 4002 user-rejected,
4004 method-not-found/popup-only, 4029 limit>4MiB) + `e.message`.

**Eventos:** `provider.on("chainChanged", cb)` y `provider.on("accountChanged", cb)`
(payload de accountChanged es undefined → re-fetch `accounts`/`getAddress`).

---

## 2. Mapa método → feature (cobertura completa)

### Dashboard (`/`)
- `chainId`, `accounts` / `getAddress`, `getAssetBalance({type:null,assetId:null})` (XCH),
  conteos: `getCats`, `getNFTs`, `getOffers`, `getDids`.
- `getDerivations({limit,offset,hardened})` (preview de direcciones).
- `getPublicKeys`.
- `walletSwitchChain({chainId})` (selector mainnet/testnet11).
- Copiar dirección, badge de red, stats cards.

### Send (`/send`) — envío simple
- `transfer({ to, amount, assetId, memos?, fee? })`.
  - assetId: `null`/`""` = XCH; hex = CAT. Toggle XCH/CAT.
  - **Normalizar `to` en la UI** (el handler hace `to ?? address`; mostrar lo que se firma).
  - Input en XCH/CAT humano → convertir a mojos con BigInt (XCH 1e12, CAT 1e3).

### Batch (`/batch`) — envíos múltiples
- `bulkSendXch({ outputs:[{address,amount}], fee? })` — filas dinámicas.
- `bulkSendCat({ assetId, outputs:[...], fee? })`.
- `multiSend({ xchOutputs?, catOutputs?:{assetId,outputs}, fee? })` (XCH + 1 CAT atómico).
- Nota informativa: `combine`/`split` son **solo wallet** (4004).

### Tokens / CATs (`/tokens`)
- Lista: `getCats({limit,offset})` / `getAllCats` (enriquece name/symbol/iconUrl vía Dexie).
- `getToken({assetId})` — lookup individual.
- `issueCat({ recipientAddress, amount, fee? })` — mintear CAT single-issuance → devuelve `{id, assetId}`.
- `walletWatchAsset({ type:"cat", options:{assetId, symbol, logo?} })` — trackear CAT.
- Por-CAT: botón "enviar" (reusa Send/Batch con assetId precargado), balance, coinCount.

### NFTs (`/nfts`)
- Grid: `getNFTs({limit,offset,didId?,collectionId?})`.
  - ⚠ shape dual: `getNFTs` → `NftInfo[]` (snake_case `launcher_id`, `data_uris`);
    `chia_getNfts` → `{nfts: NftWcInfo[]}` (camelCase). Normalizar ambos en un adapter.
  - Render imagen desde `data_uris[0]` con fallback.
- `getNFTInfo({launcherId?|coinId?})` — lookup.
- `bulkMintNfts({ did, didCoinId, didDerivationIndex, nfts:[{dataUris,dataHash,metadataUris,metadataHash,licenseUris,licenseHash,royaltyAddress,royaltyTenThousandths,editionNumber,editionTotal,address}], fee? })`.
  - **Requiere un DID propio** (createDid primero). didCoinId+didDerivationIndex salen de `getDids`.
  - Form: builder de N NFTs (URIs + hashes). dataHash 32 bytes hex.
- `addNftUri({ launcherId|coinId, uriKind:"data"|"metadata"|"license", uri, fee? })`.

### Offers (`/offers`)
- `createOffer({ offerAssets:[{assetId,amount}], requestAssets:[{assetId,amount}], fee? })`
  - assetId `""` = XCH. Builder de filas ofrezco/pido. Devuelve `{id, offer}` (string offer1...).
  - Mostrar el offer string para copiar / subir a Dexie.
- `takeOffer({ offer, fee? })` — pegar offer1...
- `getOffers({limit,offset,includeCancelled})` + `getOffer({id})` — lista.
- `cancelOffer({ id, secure?, fee? })` — secure=true gasta on-chain. Filtra por origin en el SW.

### DIDs (`/dids`)
- `getDids({limit,offset})` — DIDs minteados localmente (`dids.<fp>`): launcherId, coinId, address, name, derivationIndex.
- `createDid({fee?})` → `{id, didId, didCoinId, didDerivationIndex}`. Aviso: coin eve no gastable hasta confirmar (~1 min) → re-fetch.
- `transferDid({ didCoinId, didDerivationIndex, recipientAddress, fee? })`.
- `normalizeDids` → **solo wallet** (4004), informativo.
- Stubs colección: `getNftCollections`, `getNftCollection`, `getMinterDidIds` (Fase 3, etiquetar).

### Coins / análisis (`/coins`)
- `getCoins({type?,assetId?,limit,offset,includeSpent})` — tabla con filtro xch/cat/nft.
- `getCoinsByIds({coinIds:[]})`.
- `getAssetCoins({type,assetId,limit,offset,includedLocked})` (CHIP-0002 spendable).
- `getAssetBalance({type,assetId})`.
- `filterUnlockedCoins({coinNames:[]})`.
- `isAssetOwned({type:"cat"|"did"|"nft", assetId})`.
- **Análisis derivado en cliente:** total mojos, # coins, distribución por tamaño,
  coins locked vs unlocked, polvo (dust), tabla ordenable, mini-histograma.
- Nota: `combine`/`split` solo wallet.

### Activity (`/activity`)
- `getTransactions({limit,offset,pendingOnly})` — incoming/outgoing, confirmed/pending.
- `getPendingTransactions()`.
- Formatear montos (XCH/CAT), dirección, timestamp.

### Signing (`/signing`)
- `signMessage({ message(hex), publicKey })` → hex sig. Helper texto→hex.
- `signMessageByAddress({ message(hex), address })` → `{publicKey, signature}`.

### Advanced / consola raw (`/advanced`)
- Dropdown con los 47 métodos + textarea JSON params (mirror del playground, dentro del shell).
- `signCoinSpends({ coinSpends:[], partialSign? })` — pegar coin spends.
- `sendTransaction({ spendBundle:{coin_spends, aggregated_signature} })` — pegar bundle.
- Log de actividad (request/response, copiable).
- ⚠ Estos son blind-sign: dejar warning visible.

---

## 3. Árbol de archivos

```
apps/dapp/
├── PLAN.md                      (este archivo)
├── package.json                 @ozone/dapp · deps react/react-dom/react-router-dom · dev: @ozone/goby-provider workspace:*, vite, @vitejs/plugin-react, typescript, @types/*
├── vite.config.ts               plugin-react, base "/", build.outDir dist
├── tsconfig.json                moduleResolution "bundler", jsx react-jsx, strict
├── tsconfig.node.json
├── index.html                   carga theme inline + #root + main.tsx
├── vercel.json                  framework vite + SPA rewrite (defensivo)
├── public/
│   ├── icon.png                 (copiar de docs/assets/icon.png)
│   └── favicon
└── src/
    ├── main.tsx                 ReactDOM.createRoot + <HashRouter><App/></HashRouter>
    ├── App.tsx                  rutas + ProviderProvider + gates
    ├── styles.css               tokens de marca Loroco + dark mode (port de docs/styles.css)
    ├── theme.ts                 toggle data-theme (port de docs/theme.js, key "loroco-theme")
    ├── provider/
    │   ├── client.ts            detectProvider(), call<M>(method, params) tipado
    │   ├── ProviderContext.tsx  Context: provider, status, connected, account, accounts, chainId; connect(scope), refresh(); on chainChanged/accountChanged
    │   └── useProvider.ts        hook + useCall (loading/error/result)
    ├── lib/
    │   ├── mojos.ts             BigInt: xchToMojos/mojosToXch (1e12), catToMojos/mojosToCat (1e3), parse/format decimal seguro
    │   ├── format.ts            shortenAddress (no sobre-truncar: 10/8), shortenHex, fmtNumber, timeAgo
    │   ├── hex.ts               textToHex / hexToText, isHex32
    │   └── nft.ts               normalizeNft(NftInfo|NftWcInfo) → shape único para render
    ├── components/
    │   ├── ui/                  Button, Card, Field(Input/Textarea/Select), Modal, Table, Tag, Toast/ToastProvider, CopyText, JsonViewer, EmptyState, Stat, ResultPanel, AmountInput (XCH/CAT↔mojos), AddressInput, RecipientRows
    │   └── layout/              AppShell (sidebar nav), TopBar (account+chain+theme), ConnectGate, InstallGate, MethodBadge
    └── features/
        ├── dashboard/Dashboard.tsx
        ├── send/Send.tsx
        ├── batch/Batch.tsx
        ├── tokens/Tokens.tsx
        ├── nfts/Nfts.tsx
        ├── offers/Offers.tsx
        ├── dids/Dids.tsx
        ├── coins/Coins.tsx
        ├── activity/Activity.tsx
        ├── signing/Signing.tsx
        └── advanced/Advanced.tsx
```

---

## 4. Capa de provider (núcleo, hacerla primero y con cuidado)

`client.ts`:
```ts
export function detectProvider(): ChiaWallet | null {
  return (window.loroco || window.chia || window.ozone) ?? null;
}
export async function call<M extends ChiaMethod>(
  method: M, params?: ChiaMethodMap[M]["params"]
): Promise<ChiaMethodMap[M]["result"]> {
  const p = detectProvider();
  if (!p) throw new Error("Loroco no detectado");
  return p.request(params === undefined ? { method } : { method, params });
}
```

`ProviderContext.tsx` — estado global:
- `status`: `"detecting" | "absent" | "present"` (poll cada 150ms hasta ~6s).
- `connected: boolean`, `account: string|null`, `accounts: string[]`, `chainId: ChainId|null`.
- `connect(scope?: "full"|"read-only")` → `requestAccounts` (conecta + trae cuentas); luego `refresh()`.
- `refresh()` → `chainId`, `accounts`/`getAddress`.
- Suscribir `chainChanged`/`accountChanged` y re-fetch.
- Exponer `call` envuelto para que features no importen client directo.

`useCall` (hook ergonómico para botones):
```ts
const { run, loading, result, error } = useCall("getCats");
await run({ limit: 20 });
```

---

## 5. Gates de UI (orden de pantallas)

1. `status === "detecting"` → spinner "Detectando Loroco…".
2. `status === "absent"` → **InstallGate**: CTA Chrome Web Store
   (`https://chromewebstore.google.com/detail/jkpbdpldleedflbgpemgpigdhnlmaklp`) + link a docs.
3. `present && !connected` → **ConnectGate**: botón Connect (scope full / read-only) + explicación
   "cada firma se aprueba en el wallet".
4. `connected` → **AppShell** con sidebar + features.

---

## 6. Estilo / marca

Portar tokens de `docs/styles.css` (terracota `--orange #e8590c`, verde `--green #5c940d`,
papel/tinta, dark mode vía `:root[data-theme="dark"]`). Toggle igual que `docs/theme.js`
(localStorage `loroco-theme`, set antes del primer paint en `index.html`). Fuente system-ui;
mono para hashes. Reutilizar clases conceptuales (`.card`, `.btn`, `.tag-read/.tag-write`,
`.note.warn/.danger/.info`, `.pill`). Layout app: sidebar fija + contenido scroll.
Iconos: emoji o SVG inline (sin dep de icon lib).

---

## 7. Gotchas a no olvidar (de CLAUDE.md + memoria)

- **Reads también requieren connect** previo (no asumir que `getCats` funciona sin grant).
- **`transfer` normaliza `to ?? address`** → la UI muestra exactamente lo que se firma.
- **`getNFTs` shape dual** (snake_case vs `{nfts:[...]}` camelCase) → adapter `normalizeNft`.
- **Mojos > 2^53** → SIEMPRE BigInt para montos; nunca `Number()` sobre balances.
- **CAT decimales = 3** (1 CAT = 1000 mojos); **XCH = 12** (1 XCH = 1e12).
- **combine/split/normalizeDids = 4004** desde web → marcar "solo wallet", no accionar.
- **bulkMintNfts/transferDid** necesitan `didCoinId`+`didDerivationIndex` (de `getDids`/`createDid`); DID debe estar confirmado.
- **createDid**: coin eve no gastable hasta confirmar (~1 min) → avisar y permitir re-fetch.
- **cap 4 MiB** en payloads → validar tamaño en signCoinSpends/sendTransaction antes de enviar (error amigable).
- **CAT sync lag** tras unlock → pollear getCats unos segundos (como el playground).
- **No truncar** direcciones/asset ids al punto de ocultar un swap (10/8 chars).
- Hardened/unhardened: la dApp no elige derivation_kind; lo maneja el engine. Solo pasar params estándar.

---

## 8. Pasos de build (orden de ejecución)

1. `git checkout feat/dapp-console` (ya existe).
2. Editar `pnpm-workspace.yaml`: agregar `- "apps/*"` (leer el archivo antes de Edit).
3. Escribir scaffold (package.json, vite/tsconfig, index.html, vercel.json, vite-env.d.ts).
4. `pnpm install` desde la raíz del monorepo.
5. Copiar `docs/assets/icon.png` → `apps/dapp/public/icon.png`.
6. Construir núcleo: styles.css, theme.ts, lib/*, provider/*.
7. Construir UI kit + layout/gates + App/router.
8. Construir features (Dashboard + Send como plantilla; el resto puede paralelizarse
   con subagentes dándoles las firmas exactas + UI kit + plantilla; cada uno escribe
   solo su archivo en `features/<x>/` para no chocar; integrar rutas al final).
9. `pnpm --filter @ozone/dapp typecheck` y `... build` en verde. Arreglar tipos.
10. `pnpm --filter @ozone/dapp dev` + smoke test manual con la extensión cargada
    (perfil `/tmp/Loroco-PW-Shared`, wallet de prueba fp 3133543266).

---

## 9. Deploy (Vercel + dominio)

- Proyecto Vercel monorepo: **Root Directory = `apps/dapp`** (Vercel detecta workspace pnpm
  y corre install en la raíz automáticamente). Framework preset = Vite, output `dist`.
  Alternativa si falla: Root = raíz repo, `buildCommand: pnpm --filter @ozone/dapp build`,
  `outputDirectory: apps/dapp/dist`.
- Usar tooling Vercel disponible (`vercel:deploy` skill / MCP). Auth puede requerir login
  interactivo → pedir al usuario `! vercel login` si hace falta.
- Dominio: agregar `loroco.marvinquevedo.com` en el proyecto → Vercel da el target CNAME
  (`cname.vercel-dns.com`). El usuario crea el registro **CNAME** en el DNS de
  `marvinquevedo.com`. Verificar SSL auto.
- `vercel.json` (defensivo): `{ "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }] }`
  (con HashRouter no es estrictamente necesario, pero no estorba).

---

## 10. Definición de "hecho"

- [ ] `apps/dapp` scaffolded, `pnpm install` OK, en workspace.
- [ ] Provider layer + gates: detecta, conecta, refleja account/chain, reacciona a eventos.
- [ ] Las 11 secciones renderizan y ejercitan sus métodos (47 cubiertos; popup-only y stubs etiquetados).
- [ ] Montos siempre en BigInt; conversiones XCH/CAT correctas.
- [ ] `typecheck` y `build` en verde.
- [ ] Smoke test manual con extensión: connect → dashboard con datos reales → un read y un mutante (self-send) aprobados.
- [ ] Deploy en Vercel; `loroco.marvinquevedo.com` resolviendo con SSL.
- [ ] Commit en `feat/dapp-console` + PR.

---

### Apéndice — referencias en el repo
- Firmas exactas: `packages/goby-provider/src/types.ts` (`ChiaMethodMap`, result types).
- Gating: `packages/extension/src/background/permissions.ts`.
- Aliases: `packages/extension/src/background/rpc-router.ts` (`METHOD_ALIASES`).
- Playground de referencia (vanilla, todos los métodos): `scripts/playground/index.html`.
- Marca/tema: `docs/styles.css`, `docs/theme.js`, `docs/assets/icon.png`.

// pw-store-shots.mjs — capture tight popup crops with REAL synced data for the
// Chrome Web Store listing. Unlocks the shared profile, waits for full sync,
// then element-screenshots #root on each screen into chrome-store-screenshots/raw/.
// Post-processing (centering on a branded background) is done by compose-store-shots.sh.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const extPath = [
  resolve(root, 'packages/extension/.output/chrome-mv3'),
  resolve(root, 'packages/extension/dist'),
].find((p) => existsSync(p))
if (!extPath) {
  console.error('No built extension found. Run: pnpm build')
  process.exit(1)
}

const userDataDir = process.env.USER_DATA || '/tmp/Loroco-PW-Shared'
const PASSWORD = process.env.WALLET_PW || 'test-password-123'
const OUT = resolve(root, 'chrome-store-screenshots/raw')
mkdirSync(OUT, { recursive: true })

const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2, // crisp 2x crops for downscaled compositing
  args: [
    `--disable-extensions-except=${extPath}`,
    `--load-extension=${extPath}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
  ],
  channel: 'chrome',
})

const [bg] = ctx.serviceWorkers()
const sw = bg || (await ctx.waitForEvent('serviceworker'))
const extId = sw.url().split('/')[2]
const POPUP = `chrome-extension://${extId}/popup.html`

const page = await ctx.newPage()

async function shot(name) {
  const el = page.locator('#root')
  await el.screenshot({ path: resolve(OUT, name) })
  console.log('shot', name)
}

async function clickTab(label) {
  const el = page.getByText(label, { exact: true })
  if (await el.count()) {
    await el.first().click().catch(() => {})
    await page.waitForTimeout(900)
    return true
  }
  return false
}

async function waitSynced(maxMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const synced = await page.getByText('synced', { exact: true }).count().catch(() => 0)
    if (synced) return true
    await page.waitForTimeout(2000)
    process.stdout.write('.')
  }
  console.log('\n(sync timeout — capturing current state)')
  return false
}

// 1) Unlock
await page.goto(POPUP)
await page.waitForTimeout(1200)
const pw = page.locator('input[type="password"]')
if (await pw.count()) {
  await pw.first().fill(PASSWORD)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2500)
  console.log('unlocked')
}

// 2) Wait for full sync so balances/CATs/NFTs are populated
console.log('waiting for sync')
await waitSynced()
await page.waitForTimeout(3000) // let CAT metadata + prices settle

// 3) HOME — balance + token list
await shot('01-home.png')

// 4) RECEIVE — address + QR (great visual, no sensitive data on a throwaway)
if (await clickTab('Receive')) {
  await page.waitForTimeout(1200)
  await shot('02-receive.png')
}

// 5) NFTS — wait until the scan finishes (no "Looking for" text)
if (await clickTab('NFTs')) {
  for (let i = 0; i < 30; i++) {
    const loading = await page.getByText(/Looking for NFTs/i).count().catch(() => 0)
    if (!loading) break
    await page.waitForTimeout(2000)
  }
  await page.waitForTimeout(800)
  await shot('03-nfts.png')
}

// 6) SEND — filled-in form so it doesn't look empty
if (await clickTab('Send')) {
  await page.waitForTimeout(800)
  const addr = page.locator('input[placeholder^="xch1"]')
  if (await addr.count()) {
    await addr.first().fill('xch1qqqkmsgx9d8y0r9k0wh2v7q3l5e4n6m8p0u2w4z6a8c0d2f4h6j8')
  }
  const amount = page.locator('input[placeholder="0.0"]')
  if (await amount.count()) await amount.first().fill('0.25')
  await page.waitForTimeout(600)
  await shot('04-send.png')
}

// back to HOME
await clickTab('Home').catch(() => {})

console.log('\nraw shots in', OUT)
await page.waitForTimeout(1000)
await ctx.close()

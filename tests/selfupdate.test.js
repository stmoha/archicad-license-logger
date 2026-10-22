// Real-browser test of the update path the server relies on:
// - the manifest key gives the extension a fixed ID, so settings survive updates
// - after files change on disk (a git pull) with a new version, the extension
//   notices, reloads itself and runs the new code
// - with no new version, it does nothing
//
// Uses Playwright's Chromium (CI: `npx playwright install chromium`), or set
// CHROMIUM_PATH to a Chromium executable.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const SRC = path.join(__dirname, '..', 'extension');

function idFromKey(key) {
  const hex = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-'));
  const ext = path.join(work, 'extension');
  fs.cpSync(SRC, ext, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));

  // Playwright's default flags block extension reloads; load it the way Chrome's
  // "Load unpacked" does.
  const browser = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' };
  const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), Object.assign(browser, {
    headless: true,
    args: [`--load-extension=${ext}`, '--no-sandbox', '--enable-unsafe-extension-debugging'],
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
  }));
  try {
    let sw = ctx.serviceWorkers().find((w) => w.url().endsWith('/background.js'))
      || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
    const id = new URL(sw.url()).host;
    assert.strictEqual(id, idFromKey(manifest.key));
    console.log('  ok  extension ID is fixed by the manifest key (' + id + ')');

    assert.strictEqual(await sw.evaluate(() => checkForUpdate()), false);
    console.log('  ok  no reload when the version on disk is unchanged');

    const next = manifest.version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(Object.assign({}, manifest, { version: next }), null, 2));
    fs.appendFileSync(path.join(ext, 'lib.js'), '\nself.__pulledMarker = "new code";\n');

    assert.strictEqual(await sw.evaluate(() => checkForUpdate()).catch(() => true), true);
    let after = null;
    for (let i = 0; i < 40 && !after; i++) {
      await new Promise((r) => setTimeout(r, 500));
      for (const w of ctx.serviceWorkers()) {
        const v = await w.evaluate(() => chrome.runtime.getManifest().version).catch(() => null);
        if (v === next) after = w;
      }
    }
    assert.ok(after, 'extension did not come back on the new version');
    assert.strictEqual(new URL(after.url()).host, id);
    assert.strictEqual(await after.evaluate(() => self.__pulledMarker), 'new code');
    const st = await after.evaluate(async () => (await chrome.storage.local.get('state')).state || {});
    assert.strictEqual(st.updatedFrom, manifest.version);
    console.log(`  ok  new files on disk: reloaded itself ${manifest.version} -> ${next}, same ID, new code running`);
    console.log('\n3 checks passed');
  } finally {
    await ctx.close();
  }
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });

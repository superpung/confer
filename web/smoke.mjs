import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const PORT = 8099;
const base = `http://localhost:${PORT}`;

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', 'dist'], {
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 800));

const fails = [];
const log = (ok, msg) => { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) fails.push(msg); };

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// 1. papers render
const cards = await page.locator('.paper-card').count();
log(cards > 0, `paper cards rendered (${cards})`);

// 2. sidebar venue auto-selected
log(await page.locator('[data-venue-check]:checked').count() === 1, 'venue auto-selected');

// 3. summary text
const summary = await page.locator('#resultSummary').textContent();
log(/papers/.test(summary), `summary: "${summary?.trim()}"`);

// 4. search filters
await page.fill('#searchInput', 'security');
await page.waitForTimeout(250);
const afterSearch = await page.locator('.paper-card').count();
log(afterSearch > 0 && afterSearch < cards, `search narrows results (${afterSearch})`);
await page.fill('#searchInput', '');
await page.waitForTimeout(250);

// 5. favorite toggle
await page.locator('.favorite-button').first().click();
log(await page.locator('.favorite-button[aria-pressed="true"]').count() === 1, 'favorite toggles');

// 6. only-favorites filter
await page.check('#favOnly');
await page.waitForTimeout(150);
log(await page.locator('.paper-card').count() === 1, 'only-favorites shows 1');
await page.uncheck('#favOnly');
await page.waitForTimeout(150);

// 7. facets open + a track filter exists
await page.click('[data-facets-toggle]');
log(await page.locator('#facets .facet-option').count() > 0, 'facets render options');

// 8. theme toggle
await page.click('[data-theme-toggle]');
log(await page.getAttribute('html', 'data-theme') === 'dark', 'theme toggles to dark');

// 9. selection -> export bar
await page.locator('.card-select input').first().check();
await page.waitForTimeout(100);
log(!(await page.locator('#exportBar').isHidden()), 'export bar appears on selection');

// 10. no console errors
log(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);

await browser.close();
server.kill();

console.log(fails.length ? `\n${fails.length} FAILED` : '\nALL PASSED');
process.exit(fails.length ? 1 : 0);

#!/usr/bin/env node
/**
 * Generates the documentation screenshots by driving the UI harness with a real browser.
 *
 * The harness (`scripts/ui-harness.mjs`) boots the actual client core in Node, seeds a demo
 * workspace and serves the production webview, so these screenshots show the real interface —
 * not a mock-up. Every shot corresponds to one area of the product.
 *
 * Requirements: `npm run compile` first, then
 *   npm run screenshots                 # all shots, light + dark
 *   npm run screenshots -- --only 03    # one shot
 *
 * A browser is required. If `playwright-core` is installed the script uses it directly; otherwise
 * it looks for `CHROMIUM_PATH` (or a system Chrome/Chromium) and drives it over CDP.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'docs', 'screenshots');

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only = onlyIndex > -1 ? String(args[onlyIndex + 1]).split(',') : null;
const themes = args.includes('--dark-only') ? ['dark'] : args.includes('--light-only') ? ['light'] : ['light', 'dark'];

/** Shots in documentation order. `steps` are executed with the Playwright-like page API. */
const SHOTS = [
  {
    id: '01',
    slug: 'main-dashboard',
    title: 'Main dashboard and sidebar',
    steps: async () => {}
  },
  {
    id: '02',
    slug: 'request-builder',
    title: 'HTTP request builder',
    steps: async (page) => {
      await openRequest(page, 'Charge card');
    }
  },
  {
    id: '03',
    slug: 'response-viewer',
    title: 'API response viewer',
    steps: async (page) => {
      await openRequest(page, 'Charge card');
      await sendRequest(page);
    }
  },
  {
    id: '04',
    slug: 'headers-query',
    title: 'Headers and query parameters',
    steps: async (page) => {
      await openRequest(page, 'List products');
      await page.click('.request-workspace .tab-item[data-tab="headers"]');
      await page.waitForTimeout(250);
    }
  },
  {
    id: '05',
    slug: 'authentication',
    title: 'Authentication manager',
    steps: async (page) => {
      await openRequest(page, 'Charge card');
      await page.click('.request-workspace .tab-item[data-tab="auth"]');
      await page.waitForTimeout(250);
    }
  },
  {
    id: '06',
    slug: 'collections',
    title: 'Collections and folders',
    steps: async (page) => {
      await page.click('.sidebar-tab[data-section="collections"]');
      await page.waitForTimeout(300);
    }
  },
  {
    id: '07',
    slug: 'environments',
    title: 'Environment manager',
    steps: async (page) => {
      await page.click('.sidebar-tab[data-section="environments"]');
      // Open the manager for the active environment so the editor pane is populated.
      await page.waitForTimeout(500);
    }
  },
  {
    id: '08',
    slug: 'testing',
    title: 'Automated API testing',
    steps: async (page) => {
      await openRequest(page, 'List products');
      await sendRequest(page);
      await page.click('.response-tabs .tab-item[data-rtab="tests"]');
      await page.waitForTimeout(300);
    }
  },
  {
    id: '09',
    slug: 'websocket',
    title: 'WebSocket testing',
    steps: async (page) => {
      await page.click('.sidebar-tab[data-section="websocket"]');
      await page.waitForTimeout(400);
      // The harness host keeps a live socket between shots (the theme loop reuses one host), so a
      // previous run may have left it connected; disconnect first for a deterministic screenshot.
      const disconnect = page.locator('#ws-disconnect');
      if (await disconnect.isVisible().catch(() => false)) {
        await disconnect.click();
        await page.waitForTimeout(500);
      }
      await page.fill('#ws-url', process.env.ELY_WS_URL || 'ws://127.0.0.1:9100/ws');
      await page.click('#ws-connect');
      await page.waitForTimeout(700);
      await page.fill('#ws-message', '{"ping": true}');
      await page.click('#ws-send');
      await page.waitForTimeout(500);
    }
  },
  {
    id: '10',
    slug: 'settings',
    title: 'Settings and preferences',
    steps: async (page) => {
      await page.click('#btn-settings');
      await page.waitForTimeout(400);
    }
  }
];

/* ------------------------------- helpers -------------------------------- */

async function openRequest(page, name) {
  await page.click('.sidebar-tab[data-section="collections"]');
  const row = page.locator('.tree-row').filter({ hasText: name }).first();
  await row.click();
  await page.waitForTimeout(400);
}

async function sendRequest(page) {
  await page.click('#btn-send');
  await page.waitForTimeout(1500);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * playwright-core is an optional toolchain dependency: it is not needed to build or run the
 * extension, so it is resolved from the project (if installed) or from ELY_PLAYWRIGHT_DIR.
 */
async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    /* fall through to an explicit location */
  }
  const custom = process.env.ELY_PLAYWRIGHT_DIR;
  if (custom) {
    try {
      return await import(new URL(`file://${custom}/playwright-core/index.mjs`).href);
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function resolveExecutable() {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }
  for (const candidate of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome-stable']) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  const sparticuz = await loadOptional('@sparticuz/chromium');
  if (sparticuz && typeof sparticuz.executablePath === 'function') {
    return sparticuz.executablePath();
  }
  return null;
}

/** Resolves an optional module from the project, else from ELY_PLAYWRIGHT_DIR (ESM or CJS). */
async function loadOptional(name) {
  try {
    return await import(name);
  } catch {
    /* not installed in the project */
  }
  const custom = process.env.ELY_PLAYWRIGHT_DIR;
  if (!custom) {
    return null;
  }
  // Resolve through the package's own manifest so bundlers/`exports` maps are honoured.
  try {
    const manifest = JSON.parse(await readFile(join(custom, name, 'package.json'), 'utf8'));
    const exported = manifest.exports?.['.'];
    const relative = typeof exported === 'string' ? exported : exported?.default ?? manifest.main ?? 'index.js';
    const loaded = await import(new URL(`file://${join(custom, name, relative)}`).href);
    // CJS interop: the module may expose the class directly or nest it under `.default`.
    const resolved = loaded.default ?? loaded;
    return resolved.default ?? resolved;
  } catch {
    return null;
  }
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    process.stderr.write('screenshots: playwright-core is not installed. Run `npm install -D playwright-core`.\n');
    process.exit(1);
  }
  const executablePath = await resolveExecutable();
  if (!executablePath) {
    process.stderr.write('screenshots: no Chromium found. Set CHROMIUM_PATH or install playwright-core.\n');
    process.exit(1);
  }

  if (!existsSync(join(root, 'out', 'testing', 'harnessHost.js'))) {
    process.stderr.write('screenshots: build first with `npm run compile`.\n');
    process.exit(1);
  }

  const port = await freePort();
  const harness = spawn(process.execPath, [join(root, 'scripts', 'ui-harness.mjs'), '--port', String(port)], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const log = [];
  harness.stdout.on('data', (chunk) => log.push(chunk.toString()));
  harness.stderr.on('data', (chunk) => log.push(chunk.toString()));

  // Wait for the harness to accept HTTP requests.
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/api/state`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    harness.kill();
    process.stderr.write(`screenshots: harness did not start.\n${log.join('')}\n`);
    process.exit(1);
  }

  // The harness starts its own mock API; use its WebSocket endpoint for the live socket shot.
  const state = await (await fetch(`${base}/api/state`)).json();
  if (state.wsUrl) {
    process.env.ELY_WS_URL = state.wsUrl;
  }

  await mkdir(outDir, { recursive: true });

  const browser = await playwright.chromium.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
  });

  let failures = 0;
  const written = [];
  try {
    for (const theme of themes) {
      const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
      for (const shot of SHOTS) {
        if (only && !only.some((value) => shot.id.startsWith(value) || shot.slug.includes(value))) {
          continue;
        }
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.on('console', (message) => {
          if (message.type() === 'error') errors.push(message.text());
        });
        try {
          await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
          // Set the app's own theme state (not just the attribute): snapshot updates re-run
          // `applyTheme()`, which would otherwise overwrite a directly-set attribute.
          await page.evaluate((value) => {
            window.ElyApp.state.theme = value;
            document.body.setAttribute('data-theme', value);
          }, theme);
          await page.waitForTimeout(1200);
          await shot.steps(page);
          const file = `${shot.id}-${shot.slug}${theme === 'dark' ? '-dark' : ''}.png`;
          await page.screenshot({ path: join(outDir, file) });
          written.push(file);
          process.stdout.write(`  ✓ ${file} — ${shot.title}\n`);
          if (errors.length) {
            process.stdout.write(`    console errors: ${errors.slice(0, 2).join(' | ')}\n`);
          }
        } catch (error) {
          failures += 1;
          process.stderr.write(`  ✗ ${shot.id} ${shot.slug} (${theme}): ${error.message}\n`);
        } finally {
          await page.close();
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    harness.kill();
  }

  const indexPath = join(outDir, 'README.md');
  const rows = SHOTS.map((shot) => `| ${shot.id} | ${shot.title} | \`${shot.id}-${shot.slug}.png\` |`);
  await writeFile(
    indexPath,
    [
      '# ElyApiClient screenshots',
      '',
      'Generated by `npm run screenshots` from the real webview running against the seeded demo',
      'workspace (light theme; add `-dark` for the dark variant).',
      '',
      '| # | Area | File |',
      '| - | ---- | ---- |',
      ...rows,
      ''
    ].join('\n'),
    'utf8'
  );

  process.stdout.write(`\n${written.length} screenshot(s) written to docs/screenshots/\n`);
  if (failures) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`screenshots failed: ${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});

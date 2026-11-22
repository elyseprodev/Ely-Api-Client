#!/usr/bin/env node
/**
 * Build script for ElyApiClient.
 *
 * 1. Compiles TypeScript (strict) to `out/`.
 * 2. Verifies that the webview assets required by the panel provider are present.
 *
 * Usage: node scripts/package.mjs [--skip-tsc]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skipTsc = process.argv.includes('--skip-tsc');

function step(label, fn) {
  process.stdout.write(`› ${label}\n`);
  fn();
}

step('TypeScript compile', () => {
  if (skipTsc) {
    process.stdout.write('  (skipped)\n');
    return;
  }
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', '.'], {
    cwd: root,
    stdio: 'inherit'
  });
});

step('Verify webview assets', () => {
  const required = [
    'media/webview/index.html',
    'media/styles/main.css',
    'media/scripts/core.js',
    'media/scripts/json.js',
    'media/scripts/components.js',
    'media/scripts/app.js',
    'media/icons/activity-bar.svg',
    'media/icons/marketplace-icon.png'
  ];
  for (const file of required) {
    if (!existsSync(join(root, file))) {
      throw new Error(`missing webview asset: ${file}`);
    }
  }
});

step('Create output directories', () => {
  mkdirSync(join(root, 'out'), { recursive: true });
});

process.stdout.write('✔ ElyApiClient build complete\n');

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Packaging guard.
 *
 * The .vsix is what users actually install, so a dependency that exists in node_modules but is
 * dropped by .vscodeignore is invisible to every other test — the extension simply crashes on
 * activation with "Cannot find module". That exact bug shipped once (acorn was excluded while
 * ws was allowed, and only acorn's .d.ts survived), so these assertions pin the packaging rules.
 */

const root = process.cwd();

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

const pkg = readJson<{
  dependencies?: Record<string, string>;
  main?: string;
  icon?: string;
  contributes?: { commands?: { command: string }[]; configuration?: { properties?: Record<string, unknown> } };
  engines?: { vscode?: string };
}>( 'package.json' );

const ignoreRules = readFileSync(join(root, '.vscodeignore'), 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

/** True when a rule in .vscodeignore would drop the given module directory. */
function isExcluded(moduleName: string): boolean {
  const allowed = ignoreRules.some((rule) => rule === `!node_modules/${moduleName}/**`);
  if (allowed) {
    return false;
  }
  return ignoreRules.some((rule) => rule === 'node_modules/**' || rule === `node_modules/${moduleName}/**`);
}

describe('vsix packaging', () => {
  it('declares at least one runtime dependency', () => {
    expect(Object.keys(pkg.dependencies ?? {}).length).toBeGreaterThan(0);
  });

  it('keeps every runtime dependency inside the vsix', () => {
    const runtime = Object.keys(pkg.dependencies ?? {});
    const dropped = runtime.filter((name) => isExcluded(name));
    // A dropped dependency cannot be resolved from the installed extension.
    expect(dropped, `these runtime dependencies are excluded by .vscodeignore: ${dropped.join(', ')}`).toEqual([]);
  });

  it('allow-lists each runtime dependency explicitly', () => {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(ignoreRules, `${name} must be allow-listed in .vscodeignore`).toContain(`!node_modules/${name}/**`);
    }
  });

  it('allows each runtime dependency to resolve its entry point', () => {
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const dir = join(root, 'node_modules', name);
      expect(existsSync(dir), `${name} is not installed`).toBe(true);
      const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        main?: string;
        exports?: unknown;
      };
      // `main` (CommonJS) is what the extension host requires at runtime.
      expect(meta.main, `${name} has no CommonJS main entry`).toBeTruthy();
      expect(existsSync(join(dir, meta.main!)), `${name}/${meta.main} is missing`).toBe(true);
    }
  });

  it('points main at the compiled entry point', () => {
    expect(pkg.main).toBe('./out/extension.js');
    // The source must exist for `npm run compile` to produce the entry point.
    expect(existsSync(join(root, 'src', 'extension.ts')), 'src/extension.ts must exist').toBe(true);

    const compiled = pkg.main!.replace(/^\.\//, '');
    expect(
      existsSync(join(root, compiled)),
      `${compiled} is missing. The extension host loads this file, so the package would not start.\n` +
        'Run `npm run compile` (or `npm test`, which compiles first) and re-run the suite.'
    ).toBe(true);
  });

  it('references an icon that exists', () => {
    if (!pkg.icon) return;
    expect(existsSync(join(root, pkg.icon)), `icon ${pkg.icon} is missing`).toBe(true);
  });

  it('does not ship sources, tests or build scripts', () => {
    for (const dir of ['src/**', 'test/**', 'scripts/**']) {
      expect(ignoreRules).toContain(dir);
    }
  });

  it('ships the media assets the webview loads', () => {
    // The webview HTML references these by fixed path; a rename here breaks the UI.
    for (const file of [
      'media/webview/index.html',
      'media/styles/main.css',
      'media/scripts/app.js',
      'media/scripts/core.js',
      'media/scripts/components.js',
      'media/scripts/json.js'
    ]) {
      expect(existsSync(join(root, file)), `${file} is missing`).toBe(true);
    }
    const scripts = readdirSync(join(root, 'media', 'scripts'));
    expect(scripts.length).toBeGreaterThanOrEqual(4);
  });
});

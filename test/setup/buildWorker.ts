/**
 * Vitest global setup.
 *
 * Script assertions do not run in-process: `ScriptRunner` spawns a `node:worker_threads` Worker
 * from the *compiled* `out/scripting/scriptRuntime.js`. Tests that execute `pm.test(...)` therefore
 * depend on a build artefact, which a fresh clone does not have — the assertions silently came back
 * empty and four tests failed for the wrong reason.
 *
 * Rather than forcing everyone to remember `npm run compile`, build the worker on demand. It is a
 * one-shot ~4s compile, skipped entirely once `out/` exists.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function setup(): Promise<void> {
  const worker = join(root, 'out', 'scripting', 'scriptRuntime.js');
  if (existsSync(worker)) {
    return;
  }
  process.stdout.write('\n[setup] out/scripting/scriptRuntime.js missing - compiling the script worker\n');
  try {
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', '.'], {
      cwd: root,
      stdio: 'inherit'
    });
  } catch {
    process.stdout.write('[setup] compile failed; tests that run scripts will report missing assertions\n');
  }
}

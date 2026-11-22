import { Worker } from 'node:worker_threads';
import * as path from 'node:path';
import * as acorn from 'acorn';
import type { ScriptConsoleEntry, TestResult } from '../models/types';
import type { ScriptEnvironment } from './SandboxApi';

/**
 * Runs untrusted user scripts in an isolated worker thread with a `vm` context, a wall-clock
 * timeout and a memory limit. The extension host never evaluates user code.
 */

export interface ScriptRunOptions {
  code: string;
  phase: 'pre-request' | 'tests';
  environment: ScriptEnvironment;
  timeoutMs: number;
  memoryLimitMb: number;
}

export interface ScriptRunResult {
  ok: boolean;
  error?: string;
  stack?: string;
  results: TestResult[];
  console: ScriptConsoleEntry[];
  variables: Record<string, string>;
  environment: Record<string, string>;
  durationMs: number;
  timedOut?: boolean;
}

interface WorkerOutput {
  ok: boolean;
  error?: string;
  stack?: string;
  tests: { name: string; passed: boolean; error?: string; stack?: string; durationMs: number }[];
  console: ScriptConsoleEntry[];
  variables: Record<string, string>;
  environment: Record<string, string>;
  durationMs: number;
}

export class ScriptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScriptValidationError';
  }
}

const FORBIDDEN_IDENTIFIERS = new Set([
  'require',
  'process',
  'module',
  'exports',
  'importScripts',
  'globalThis',
  'window',
  'document',
  'XMLHttpRequest',
  'fetch',
  'WebSocket',
  'Worker',
  'SharedArrayBuffer'
]);

/**
 * Parses the script and walks its AST to reject dangerous constructs before execution:
 * imports, dynamic `eval`/`Function`, and access to host globals. This is defence in depth on top
 * of the vm sandbox (which does not expose those globals anyway).
 */
export function validateScript(code: string): { ok: boolean; error?: string; line?: number } {
  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (error) {
    const err = error as Error & { loc?: { line: number; column: number } };
    const position = err.loc ? ` (line ${err.loc.line}, column ${err.loc.column + 1})` : '';
    return { ok: false, error: `Syntax error: ${err.message}${position}`, line: err.loc?.line };
  }

  const walk = (node: unknown, ancestors: Set<string>): string | undefined => {
    if (!node || typeof node !== 'object') {
      return undefined;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        const issue = walk(child, ancestors);
        if (issue) {
          return issue;
        }
      }
      return undefined;
    }
    const record = node as Record<string, unknown> & { type?: string; start?: number; loc?: { line: number } };
    switch (record.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration':
        return 'ES module syntax is not supported in scripts.';
      case 'Identifier':
        if (typeof record.name === 'string' && FORBIDDEN_IDENTIFIERS.has(record.name) && !ancestors.has('MemberExpression')) {
          return `Access to "${record.name}" is not allowed in scripts.`;
        }
        break;
      case 'MemberExpression': {
        const object = record.object as { type?: string; name?: string } | undefined;
        if (object?.type === 'Identifier' && object.name) {
          // pm.constructor / pm.__proto__ style escape attempts.
          const property = record.property as { type?: string; name?: string; value?: unknown } | undefined;
          const propertyName = property?.type === 'Identifier' ? property.name : (property?.value as string | undefined);
          if (['constructor', '__proto__', 'prototype'].includes(String(propertyName))) {
            return `Access to "${String(propertyName)}" is not allowed in scripts.`;
          }
        }
        break;
      }
      case 'CallExpression': {
        const callee = record.callee as { type?: string; name?: string } | undefined;
        if (callee?.type === 'Identifier' && (callee.name === 'eval' || callee.name === 'Function')) {
          return 'Dynamic code evaluation is not allowed in scripts.';
        }
        break;
      }
      default:
        break;
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === 'loc' || key === 'start' || key === 'end') {
        continue;
      }
      const nextAncestors = new Set(ancestors);
      if (record.type) {
        nextAncestors.add(record.type);
      }
      const issue = walk(value, nextAncestors);
      if (issue) {
        return issue;
      }
    }
    return undefined;
  };

  const issue = walk(ast, new Set());
  if (issue) {
    return { ok: false, error: issue };
  }
  return { ok: true };
}

export class ScriptRunner {
  /** Absolute path to the compiled worker bundle. */
  private readonly bundlePath: string;
  private readonly customPath: boolean;
  private activeWorkers = new Set<Worker>();

  /**
   * @param workerPath Optional explicit path to the compiled `scriptRuntime.js` worker (tests).
   *   By default the module is resolved next to this file, which works both for the compiled
   *   extension (`out/scripting/scriptRuntime.js`) and when tests load sources from `src/`.
   */
  constructor(workerPath?: string) {
    if (workerPath) {
      this.bundlePath = workerPath;
      this.customPath = true;
      return;
    }
    this.customPath = false;
    this.bundlePath = '';
  }

  /** Resolved lazily so a missing build produces a clear error only when scripts actually run. */
  private resolveBundlePath(): string {
    if (this.customPath) {
      return this.bundlePath;
    }
    try {
      return require.resolve('./scriptRuntime');
    } catch {
      const compiled = path.join(__dirname, '..', '..', 'out', 'scripting', 'scriptRuntime.js');
      return compiled;
    }
  }

  async run(options: ScriptRunOptions): Promise<ScriptRunResult> {
    const started = Date.now();
    const validation = validateScript(options.code);
    if (!validation.ok) {
      return {
        ok: false,
        error: validation.error,
        results: [],
        console: [],
        variables: {},
        environment: {},
        durationMs: 0
      };
    }

    return new Promise<ScriptRunResult>((resolve) => {
      let settled = false;
      let worker: Worker;
      const timeoutMs = Math.max(100, options.timeoutMs);
      const settle = (result: ScriptRunResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.activeWorkers.delete(worker);
        void worker.terminate();
        resolve(result);
      };

      try {
        worker = new Worker(this.resolveBundlePath(), {
          workerData: {
            code: options.code,
            phase: options.phase,
            timeoutMs,
            environment: options.environment
          },
          resourceLimits: {
            maxOldGenerationSizeMb: Math.max(8, options.memoryLimitMb),
            maxYoungGenerationSizeMb: Math.max(4, Math.min(32, Math.floor(options.memoryLimitMb / 2))),
            stackSizeMb: 4
          },
          stdout: true,
          stderr: true
        });
      } catch (error) {
        resolve({
          ok: false,
          error: `Could not start the script sandbox: ${(error as Error).message}`,
          results: [],
          console: [],
          variables: {},
          environment: {},
          durationMs: Date.now() - started
        });
        return;
      }

      this.activeWorkers.add(worker);

      const timer = setTimeout(() => {
        settle({
          ok: false,
          error: `The script exceeded the ${timeoutMs} ms execution limit and was stopped.`,
          results: [],
          console: [],
          variables: {},
          environment: {},
          durationMs: Date.now() - started,
          timedOut: true
        });
      }, timeoutMs + 1000);

      worker.on('message', (message: WorkerOutput) => {
        settle({
          ok: message.ok,
          error: message.error,
          stack: message.stack,
          results: message.tests.map((test) => ({
            name: test.name,
            passed: test.passed,
            durationMs: test.durationMs,
            error: test.error,
            stack: test.stack
          })),
          console: message.console,
          variables: message.variables,
          environment: message.environment,
          durationMs: message.durationMs
        });
      });

      worker.on('error', (error) => {
        const isMemory = /heap out of memory|Allocation failed/i.test(error.message);
        settle({
          ok: false,
          error: isMemory
            ? `The script exceeded the ${options.memoryLimitMb} MB memory limit.`
            : `Script error: ${error.message}`,
          results: [],
          console: [],
          variables: {},
          environment: {},
          durationMs: Date.now() - started
        });
      });

      worker.on('exit', (code) => {
        if (!settled) {
          settle({
            ok: false,
            error: code === 0 ? 'The script sandbox exited without returning a result.' : `The script sandbox exited with code ${code}.`,
            results: [],
            console: [],
            variables: {},
            environment: {},
            durationMs: Date.now() - started
          });
        }
      });
    });
  }

  /** Terminates every running script (called on deactivation). */
  dispose(): void {
    for (const worker of this.activeWorkers) {
      void worker.terminate();
    }
    this.activeWorkers.clear();
  }
}

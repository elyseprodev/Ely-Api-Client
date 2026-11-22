/**
 * Worker entry point for running user scripts in a restricted `vm` context.
 *
 * This file is bundled together with SandboxApi.ts into `out/scripting/sandbox.bundle.js` at build
 * time. It runs inside a `worker_threads` Worker with `resourceLimits` applied, so a runaway script
 * can never block or exhaust the extension host.
 */

import { parentPort, workerData } from 'node:worker_threads';
import * as vm from 'node:vm';
import { createPm, type ScriptEnvironment, type ScriptRuntime } from './SandboxApi';

interface WorkerInput {
  code: string;
  phase: 'pre-request' | 'tests';
  timeoutMs: number;
  environment: ScriptEnvironment;
}

interface WorkerOutput {
  ok: boolean;
  error?: string;
  stack?: string;
  tests: ScriptRuntime['tests'];
  console: ScriptRuntime['console'];
  variables: Record<string, string>;
  environment: Record<string, string>;
  durationMs: number;
}

function serialize(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value, (_key, val) => (typeof val === 'bigint' ? `${val}n` : val)) ?? String(value);
  } catch {
    return String(value);
  }
}

function run(input: WorkerInput): WorkerOutput {
  const started = Date.now();
  const environment: ScriptEnvironment = {
    ...input.environment,
    environment: { ...input.environment.environment },
    variables: { ...input.environment.variables }
  };
  const runtime: ScriptRuntime = {
    tests: [],
    console: [],
    variables: { ...input.environment.variables },
    environment: { ...input.environment.environment },
    request: input.environment.request
  };

  const consoleEntries: ScriptRuntime['console'] = [];
  const pushConsole = (level: 'log' | 'info' | 'warn' | 'error') => (...args: unknown[]) => {
    if (consoleEntries.length < 200) {
      consoleEntries.push({ level, message: args.map(serialize).join(' '), timestamp: Date.now() });
    }
  };

  const pm = createPm({ ...environment, variables: runtime.variables, environment: runtime.environment }, runtime);

  const sandbox: Record<string, unknown> = {
    pm,
    console: {
      log: pushConsole('log'),
      info: pushConsole('info'),
      warn: pushConsole('warn'),
      error: pushConsole('error'),
      debug: pushConsole('log')
    },
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    fetch: undefined,
    XMLHttpRequest: undefined,
    WebSocket: undefined,
    require: undefined,
    module: undefined,
    process: undefined,
    globalThis: undefined
  };
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox, {
    name: 'ElyApiClient script',
    codeGeneration: { strings: false, wasm: false }
  });

  let testError: string | undefined;
  let testStack: string | undefined;
  try {
    const script = new vm.Script(input.code, { filename: `ely-script-${input.phase}.js` });
    script.runInContext(context, { timeout: Math.max(100, input.timeoutMs), displayErrors: true, breakOnSigint: false });
  } catch (error) {
    const err = error as Error;
    testError = err?.message ?? String(error);
    testStack = err?.stack;
  }

  return {
    ok: !testError,
    error: testError,
    stack: testStack,
    tests: runtime.tests,
    console: [...runtime.console, ...consoleEntries],
    variables: runtime.variables,
    environment: runtime.environment,
    durationMs: Date.now() - started
  };
}

const port = parentPort;
if (port) {
  try {
    const input = workerData as WorkerInput;
    const output = run(input);
    port.postMessage(output);
  } catch (error) {
    const err = error as Error;
    port.postMessage({
      ok: false,
      error: err?.message ?? String(error),
      stack: err?.stack,
      tests: [],
      console: [],
      variables: {},
      environment: {},
      durationMs: 0
    } satisfies WorkerOutput);
  }
}

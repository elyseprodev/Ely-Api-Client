/**
 * Harness host process: instantiates the real client core (`AppCore`) with in-memory editor
 * stand-ins and bridges the browser webview to it through JSON lines on stdio.
 *
 * Started by `scripts/ui-harness.mjs`. Never part of the extension's activation path and never
 * imported by `extension.ts`.
 */
import * as readline from 'node:readline';
import { AppCore, HeadlessHostAdapter, type ClientTransport } from '../services/AppCore';
import type { ExtensionSettings } from '../services/SettingsService';
import { MemoryMemento, MemorySecretStorage } from './vscodeStub';
import { seedHarnessData } from './seedData';
import { startMockApi } from './mockApiServer';

const out = (message: unknown) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const listeners = new Set<(message: unknown) => void>();

const transport: ClientTransport = {
  post: (message) => {
    if (process.env.ELY_HARNESS_TRACE) {
      const kind = (message as { type?: string }).type ?? 'unknown';
      const requestId = (message as { requestId?: string }).requestId;
      process.stderr.write(`[harness out] ${kind}${requestId ? ` id=${requestId}` : ''}\n`);
    }
    out(message);
  },
  onMessage: (listener) => {
    listeners.add(listener);
    return { dispose: () => listeners.delete(listener) };
  }
};

const settings: ExtensionSettings = {
  defaultMethod: 'GET',
  timeout: 15000,
  followRedirects: 'follow',
  maxRedirects: 5,
  verifyTls: true,
  maxResponseSize: 10 * 1024 * 1024,
  maxDisplaySize: 1024 * 1024,
  prettyPrint: true,
  theme: 'auto',
  confirmBeforeDelete: true,
  historyEnabled: true,
  historyLimit: 100,
  historyRetentionDays: 30,
  historyStoreRequestBody: true,
  historyRedactSensitiveHeaders: true,
  scriptTimeoutMs: 3000,
  scriptMemoryMb: 32,
  allowPrivateNetwork: true,
  maxImportSizeBytes: 10 * 1024 * 1024,
  websocketMaxMessages: 500,
  websocketHandshakeTimeoutMs: 15000,
  trustedHosts: [],
  storageScope: 'workspace'
};

async function main(): Promise<void> {
  // A local mock API makes the demo data sendable without touching the public internet.
  const mock = await startMockApi();
  out({ type: 'harness:mock', payload: { url: mock.url, wsUrl: `ws://127.0.0.1:${mock.port}/ws` } });

  const host = new HeadlessHostAdapter();
  const workspace = new MemoryMemento();
  const core = new AppCore(
    (scope) => (scope === 'global' ? new MemoryMemento() : workspace),
    new MemorySecretStorage(),
    host,
    settings
  );

  await seedHarnessData(core, mock.url);
  core.attachTransport(transport);

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let message: unknown;
    try {
      message = JSON.parse(trimmed);
    } catch {
      out({ type: 'error', payload: { title: 'Harness', message: 'Invalid JSON from browser' } });
      return;
    }
    if (process.env.ELY_HARNESS_TRACE) {
      const kind = (message as { type?: string }).type ?? 'unknown';
      const requestId = (message as { requestId?: string }).requestId;
      process.stderr.write(`[harness in] ${kind}${requestId ? ` id=${requestId}` : ''}\n`);
    }
    for (const listener of [...listeners]) {
      listener(message);
    }
  });

  out({ type: 'harness:ready', payload: { cwd: process.cwd() } });
  // The browser may have posted webview:ready before the host finished booting.
  await core.handleMessage({ type: 'webview:ready' });

  const shutdown = () => {
    core.dispose();
    void mock.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main().catch((error) => {
  out({ type: 'error', payload: { title: 'Harness failed', message: String(error && error.stack ? error.stack : error) } });
  process.exit(1);
});

import { AppCore, HeadlessHostAdapter, type ClientTransport } from '../../src/services/AppCore';
import { MemoryMemento, MemorySecretStorage } from '../../src/testing/vscodeStub';
import type { ExtensionSettings } from '../../src/services/SettingsService';

export const TEST_SETTINGS: ExtensionSettings = {
  defaultMethod: 'GET',
  timeout: 8000,
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
  scriptMemoryMb: 64,
  allowPrivateNetwork: true,
  maxImportSizeBytes: 10 * 1024 * 1024,
  websocketMaxMessages: 200,
  websocketHandshakeTimeoutMs: 8000,
  trustedHosts: [],
  storageScope: 'workspace'
};

export interface TestClient {
  core: AppCore;
  host: HeadlessHostAdapter;
  messages: Record<string, unknown>[];
  send(message: Record<string, unknown>): Promise<void>;
  waitFor(type: string, predicate?: (message: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  dispose(): void;
}

/** Creates an AppCore wired to a capturing transport, mirroring how the webview talks to it. */
export function createTestClient(settings: Partial<ExtensionSettings> = {}): TestClient {
  const host = new HeadlessHostAdapter();
  const messages: Record<string, unknown>[] = [];
  const waiters: { type: string; predicate: (message: Record<string, unknown>) => boolean; resolve: (message: Record<string, unknown>) => void }[] = [];
  const transport: ClientTransport = {
    post(message) {
      const envelope = message as Record<string, unknown>;
      messages.push(envelope);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const waiter = waiters[i];
        if (waiter.type === envelope.type && waiter.predicate(envelope)) {
          waiters.splice(i, 1);
          waiter.resolve(envelope);
        }
      }
    },
    onMessage() {
      return { dispose: () => undefined };
    }
  };
  const core = new AppCore(
    () => new MemoryMemento(),
    new MemorySecretStorage(),
    host,
    { ...TEST_SETTINGS, ...settings }
  );
  core.attachTransport(transport);
  return {
    core,
    host,
    messages,
    send: (message) => core.handleMessage(message),
    waitFor(type, predicate = () => true, timeoutMs = 8000) {
      const existing = messages.find((message) => message.type === type && predicate(message));
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          predicate,
          resolve: (message) => {
            clearTimeout(timer);
            resolve(message);
          }
        });
      });
    },
    dispose: () => core.dispose()
  };
}

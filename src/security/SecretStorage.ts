import type { SecretStorage as VsSecretStorage } from 'vscode';

/**
 * Wrapper around VS Code's SecretStorage that namespaces every ElyApiClient secret and provides
 * in-memory caching so hot paths (sending a request) do not hit the OS keychain repeatedly.
 *
 * Secrets are never logged, never written to the webview and never exported.
 */
export class SecretService {
  private readonly cache = new Map<string, string | undefined>();
  private readonly pending = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly secrets: VsSecretStorage,
    private readonly prefix = 'elyApiClient'
  ) {}

  private namespaced(key: string): string {
    return `${this.prefix}.${key}`;
  }

  /** Builds a stable secret key from parts, e.g. (`auth`, requestId, `bearer`). */
  static key(...parts: string[]): string {
    return parts.map((part) => part.replace(/[^A-Za-z0-9_.:-]/g, '_')).join(':');
  }

  async get(key: string): Promise<string | undefined> {
    const full = this.namespaced(key);
    if (this.cache.has(full)) {
      return this.cache.get(full);
    }
    const inflight = this.pending.get(full);
    if (inflight) {
      return inflight;
    }
    const promise = Promise.resolve(this.secrets.get(full)).then((value) => {
      this.cache.set(full, value);
      this.pending.delete(full);
      return value;
    });
    this.pending.set(full, promise);
    return promise;
  }

  async store(key: string, value: string): Promise<void> {
    const full = this.namespaced(key);
    await this.secrets.store(full, value);
    this.cache.set(full, value);
  }

  async delete(key: string): Promise<void> {
    const full = this.namespaced(key);
    await this.secrets.delete(full);
    this.cache.set(full, undefined);
  }

  async has(key: string): Promise<boolean> {
    const value = await this.get(key);
    return value !== undefined && value !== '';
  }

  /** Stores a set of secrets atomically-ish (sequentially, stopping on first failure). */
  async storeMany(entries: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      await this.store(key, value);
    }
  }

  /** Removes every secret whose key starts with the given prefix. */
  async deleteByPrefix(prefix: string): Promise<void> {
    const full = this.namespaced(prefix);
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(full)) {
        await this.secrets.delete(key);
        this.cache.delete(key);
      }
    }
  }
}

/**
 * In-memory SecretStorage stand-in used by unit tests and when VS Code's SecretStorage is not
 * available (for example in a headless harness). Not persisted anywhere.
 */
export class MemorySecretStorage implements VsSecretStorage {
  private readonly values = new Map<string, string>();
  readonly onDidChange: import('vscode').Event<import('vscode').SecretStorageChangeEvent> = () => ({
    dispose: () => undefined
  });

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

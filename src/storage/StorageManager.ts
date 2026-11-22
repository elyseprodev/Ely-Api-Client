import type { ApiCollection, ApiEnvironment, ApiFolder, ApiRequest, HistoryEntry } from '../models/types';

/**
 * Persistence facade over VS Code's state storage.
 *
 * Layout: every top-level entity kind lives under its own key so that a corrupt entry does not
 * destroy the whole workspace. Writes are debounced and atomic per key (VS Code Memento values are
 * replaced wholesale).
 */

export interface PersistedData {
  collections: ApiCollection[];
  folders: ApiFolder[];
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  activeEnvironmentId: string | null;
  history: HistoryEntry[];
  meta: { version: number; updatedAt: string };
}

const KEYS = {
  collections: 'ely.collections',
  folders: 'ely.folders',
  requests: 'ely.requests',
  environments: 'ely.environments',
  activeEnvironmentId: 'ely.activeEnvironmentId',
  history: 'ely.history',
  meta: 'ely.meta'
} as const;

export type StorageScope = 'workspace' | 'global';

/** Structural subset of VS Code's `Memento`. */
export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
  keys?(): readonly string[];
}

export class StorageManager {
  private writeTimer: NodeJS.Timeout | undefined;
  private pendingData: Partial<PersistedData> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private memento: MementoLike) {}

  get dataKeys(): typeof KEYS {
    return KEYS;
  }

  readCollections(): ApiCollection[] {
    return this.memento.get<ApiCollection[]>(KEYS.collections, []);
  }

  readFolders(): ApiFolder[] {
    return this.memento.get<ApiFolder[]>(KEYS.folders, []);
  }

  readRequests(): ApiRequest[] {
    return this.memento.get<ApiRequest[]>(KEYS.requests, []);
  }

  readEnvironments(): ApiEnvironment[] {
    return this.memento.get<ApiEnvironment[]>(KEYS.environments, []);
  }

  readActiveEnvironmentId(): string | null {
    return this.memento.get<string | null>(KEYS.activeEnvironmentId, null);
  }

  readHistory(): HistoryEntry[] {
    return this.memento.get<HistoryEntry[]>(KEYS.history, []);
  }

  readAll(): PersistedData {
    return {
      collections: this.readCollections(),
      folders: this.readFolders(),
      requests: this.readRequests(),
      environments: this.readEnvironments(),
      activeEnvironmentId: this.readActiveEnvironmentId(),
      history: this.readHistory(),
      meta: this.memento.get(KEYS.meta, { version: 1, updatedAt: new Date().toISOString() })
    };
  }

  /** Schedules a write; multiple writes in the same tick are merged. */
  queueWrite(data: Partial<PersistedData>, debounceMs = 120): void {
    const merged = this.pendingData ?? {};
    Object.assign(merged, data);
    this.pendingData = merged;
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      const toWrite = this.pendingData;
      this.pendingData = null;
      if (toWrite) {
        void this.flush(toWrite);
      }
    }, debounceMs);
  }

  /** Writes immediately, chaining on the previous write to preserve ordering. */
  async flush(data?: Partial<PersistedData>): Promise<void> {
    const payload = data ?? this.pendingData ?? {};
    this.pendingData = null;
    this.writeChain = this.writeChain.then(async () => {
      for (const key of Object.keys(payload) as (keyof PersistedData)[]) {
        const mementoKey = key === 'meta' ? KEYS.meta : KEYS[key as keyof typeof KEYS];
        if (key === 'meta') {
          await this.memento.update(KEYS.meta, { version: 1, updatedAt: new Date().toISOString() });
          continue;
        }
        await this.memento.update(mementoKey, payload[key]);
      }
    });
    return this.writeChain;
  }

  async clearAll(): Promise<void> {
    for (const key of Object.values(KEYS)) {
      if (key === KEYS.meta) {
        continue;
      }
      await this.memento.update(key, undefined);
    }
    await this.flush({
      collections: [],
      folders: [],
      requests: [],
      environments: [],
      activeEnvironmentId: null,
      history: []
    });
  }

  dispose(): void {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = undefined;
    }
    if (this.pendingData) {
      void this.flush(this.pendingData);
    }
  }
}

/**
 * In-memory Memento used by unit tests and the headless UI harness.
 */
export class MemoryMemento implements MementoLike {
  private readonly store = new Map<string, unknown>();
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? (this.store.get(key) as T) : defaultValue) as T;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, structuredClone(value));
    }
  }
}

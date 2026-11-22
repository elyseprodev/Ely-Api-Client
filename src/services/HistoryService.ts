import type { HttpErrorDetails, HistoryEntry, SendRequestResult, ApiRequest } from '../models/types';
import { applyHistoryRetention, normalizeHistoryEntry, sanitizeRequestForHistory, type HistoryOptions } from '../models/Environment';
import { newId, nowIso } from '../models/Request';
import type { StorageManager } from '../storage/StorageManager';
import type { EmitterLike } from '../models/Emitter';

/**
 * Request history. Stores a redacted request snapshot (never response bodies) so entries can be
 * reopened and resent. Retention and size are bounded by configuration.
 */
export class HistoryService {
  private entries: HistoryEntry[] = [];
  private options: HistoryOptions = { limit: 100, retentionDays: 30, storeRequestBody: true, redactSensitiveHeaders: true };
  private enabled = true;

  private readonly changes: EmitterLike<void>;

  constructor(
    private readonly storage: StorageManager,
    onDidChange: EmitterLike<void>
  ) {
    this.changes = onDidChange;
    this.reload();
  }

  get onDidChange(): (listener: (value: void) => void) => { dispose(): unknown } {
    return this.changes.event;
  }

  reload(): void {
    this.entries = this.storage
      .readHistory()
      .map(normalizeHistoryEntry)
      .filter((entry): entry is HistoryEntry => entry !== null)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    this.entries = applyHistoryRetention(this.entries, this.options);
    this.changes.fire();
  }

  configure(options: Partial<HistoryOptions> & { enabled?: boolean }): void {
    if (options.enabled !== undefined) {
      this.enabled = options.enabled;
    }
    this.options = { ...this.options, ...options };
    const bounded = applyHistoryRetention(this.entries, this.options);
    if (bounded.length !== this.entries.length) {
      this.entries = bounded;
      this.persist();
    }
  }

  list(): HistoryEntry[] {
    return [...this.entries];
  }

  get(id: string): HistoryEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  search(query: string): HistoryEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return this.list();
    }
    return this.entries.filter(
      (entry) =>
        entry.url.toLowerCase().includes(needle) ||
        entry.name.toLowerCase().includes(needle) ||
        entry.method.toLowerCase() === needle ||
        String(entry.statusCode ?? '').includes(needle)
    );
  }

  /** Records a completed (or failed) request. No-op when history is disabled. */
  record(request: ApiRequest, result: SendRequestResult): HistoryEntry | undefined {
    if (!this.enabled) {
      return undefined;
    }
    const error: HttpErrorDetails | undefined = result.error;
    const entry: HistoryEntry = {
      id: newId(),
      requestId: request.id,
      name: request.name,
      method: request.method,
      url: result.resolved.url || request.url,
      statusCode: result.response?.status,
      statusText: result.response?.statusText,
      durationMs: result.response ? Math.round(result.response.durationMs) : Math.round(result.durationMs),
      sizeBytes: result.response?.sizeBytes,
      error: error?.message,
      request: sanitizeRequestForHistory(request, this.options),
      collectionId: request.collectionId,
      createdAt: nowIso()
    };
    this.entries.unshift(entry);
    this.entries = applyHistoryRetention(this.entries, this.options);
    this.persist();
    return entry;
  }

  remove(id: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.id !== id);
    if (this.entries.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    this.storage.queueWrite({ history: this.entries });
    this.changes.fire();
  }

  flush(): Promise<void> {
    return this.storage.flush({ history: this.entries });
  }
}

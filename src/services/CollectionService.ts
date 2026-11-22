import type { ApiCollection, ApiFolder, ApiRequest, KeyValueRow } from '../models/types';
import {
  buildTree,
  createCollection,
  createFolder,
  ensureUniqueName,
  findDescendantFolderIds,
  normalizeCollection,
  normalizeFolder,
  type TreeNode
} from '../models/Collection';
import { cloneRequest, normalizeRequest, nowIso, createRequest, type CreateRequestOptions } from '../models/Request';
import type { StorageManager } from '../storage/StorageManager';
import type { SecretService } from '../security/SecretStorage';
import type { EmitterLike } from '../models/Emitter';

export type CollectionChangeReason = 'collections' | 'folders' | 'requests' | 'reload';

export interface CollectionChangeEvent {
  reason: CollectionChangeReason;
  ids?: string[];
}

/**
 * Owns the collection tree: collections, folders and requests. All mutations go through this
 * service so persistence and change notifications stay consistent. The sidebar, webview and any
 * future API share one instance.
 */
export class CollectionService {
  private collections: ApiCollection[] = [];
  private folders: ApiFolder[] = [];
  private requests: ApiRequest[] = [];

  constructor(
    private readonly storage: StorageManager,
    private readonly secrets: SecretService,
    private readonly onDidChange: EmitterLike<CollectionChangeEvent>
  ) {
    this.reload();
  }

  get onChange(): (listener: (value: CollectionChangeEvent) => void) => { dispose(): unknown } {
    return this.onDidChange.event;
  }

  reload(): void {
    this.collections = this.storage.readCollections().map(normalizeCollection);
    const knownCollectionIds = new Set(this.collections.map((c) => c.id));
    const rawFolders = this.storage.readFolders();
    this.folders = rawFolders
      .map((folder) => normalizeFolder(folder, folder?.collectionId ?? ''))
      .filter((folder): folder is ApiFolder => !!folder && knownCollectionIds.has(folder.collectionId));
    // Drop folders whose parent no longer exists so the tree cannot break.
    const folderIds = new Set(this.folders.map((f) => f.id));
    this.folders = this.folders.map((folder) =>
      folder.parentFolderId && !folderIds.has(folder.parentFolderId) ? { ...folder, parentFolderId: null } : folder
    );
    this.requests = this.storage
      .readRequests()
      .map((request) => normalizeRequest(request))
      .filter((request) => !request.collectionId || knownCollectionIds.has(request.collectionId));
    this.onDidChange.fire({ reason: 'reload' });
  }

  /* ---------------------------------- queries --------------------------------- */

  listCollections(): ApiCollection[] {
    return [...this.collections];
  }

  listFolders(collectionId?: string): ApiFolder[] {
    return collectionId ? this.folders.filter((folder) => folder.collectionId === collectionId) : [...this.folders];
  }

  listRequests(collectionId?: string): ApiRequest[] {
    return collectionId ? this.requests.filter((request) => request.collectionId === collectionId) : [...this.requests];
  }

  getCollection(id: string): ApiCollection | undefined {
    return this.collections.find((collection) => collection.id === id);
  }

  getFolder(id: string): ApiFolder | undefined {
    return this.folders.find((folder) => folder.id === id);
  }

  getRequest(id: string): ApiRequest | undefined {
    return this.requests.find((request) => request.id === id);
  }

  getTree(): TreeNode[] {
    return buildTree(this.collections, this.folders, this.requests);
  }

  /** All collection headers that apply to a request (collection only; folders inherit too). */
  getInheritedHeaders(request: ApiRequest): KeyValueRow[] {
    const headers: KeyValueRow[] = [];
    const collection = request.collectionId ? this.getCollection(request.collectionId) : undefined;
    if (collection) {
      headers.push(...collection.headers);
    }
    let folderId = request.folderId ?? null;
    const seen = new Set<string>();
    while (folderId && !seen.has(folderId)) {
      seen.add(folderId);
      const folder = this.getFolder(folderId);
      if (!folder) {
        break;
      }
      folderId = folder.parentFolderId;
    }
    return headers;
  }

  getInheritedTests(request: ApiRequest): string[] {
    const tests: string[] = [];
    const collection = request.collectionId ? this.getCollection(request.collectionId) : undefined;
    if (collection?.scripts.tests.trim()) {
      tests.push(collection.scripts.tests);
    }
    return tests;
  }

  getCollectionVariables(request: ApiRequest): Record<string, string> {
    const collection = request.collectionId ? this.getCollection(request.collectionId) : undefined;
    const variables: Record<string, string> = {};
    for (const variable of collection?.variables ?? []) {
      if (variable.enabled && variable.key) {
        variables[variable.key] = variable.value;
      }
    }
    return variables;
  }

  /** Case-insensitive search across collections, folders and requests. */
  search(query: string): { collections: ApiCollection[]; folders: ApiFolder[]; requests: ApiRequest[] } {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return { collections: [], folders: [], requests: [] };
    }
    return {
      collections: this.collections.filter((c) => c.name.toLowerCase().includes(needle)),
      folders: this.folders.filter((f) => f.name.toLowerCase().includes(needle)),
      requests: this.requests.filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          r.url.toLowerCase().includes(needle) ||
          r.method.toLowerCase() === needle
      )
    };
  }

  /* -------------------------------- collections ------------------------------- */

  createCollection(name: string): ApiCollection {
    const existing = this.collections.map((c) => c.name);
    const collection = createCollection(ensureUniqueName(name, existing), Date.now());
    this.collections.push(collection);
    this.persist('collections');
    return collection;
  }

  updateCollection(id: string, patch: Partial<Pick<ApiCollection, 'name' | 'description' | 'headers' | 'auth' | 'scripts' | 'variables'>>): ApiCollection | undefined {
    const collection = this.getCollection(id);
    if (!collection) {
      return undefined;
    }
    const updated: ApiCollection = { ...collection, ...patch, updatedAt: nowIso() };
    if (patch.name !== undefined) {
      const existing = this.collections.filter((c) => c.id !== id).map((c) => c.name);
      updated.name = ensureUniqueName(patch.name, existing);
    }
    this.collections = this.collections.map((c) => (c.id === id ? updated : c));
    this.persist('collections');
    return updated;
  }

  async deleteCollection(id: string): Promise<boolean> {
    const collection = this.getCollection(id);
    if (!collection) {
      return false;
    }
    const folderIds = this.folders.filter((f) => f.collectionId === id).map((f) => f.id);
    const requests = this.requests.filter((r) => r.collectionId === id);
    this.collections = this.collections.filter((c) => c.id !== id);
    this.folders = this.folders.filter((f) => f.collectionId !== id);
    this.requests = this.requests.filter((r) => r.collectionId !== id);
    for (const request of requests) {
      await this.secrets.deleteByPrefix(`auth:${request.id}`);
    }
    void folderIds;
    this.persist('collections');
    this.onDidChange.fire({ reason: 'folders', ids: [id] });
    this.onDidChange.fire({ reason: 'requests', ids: [id] });
    return true;
  }

  duplicateCollection(id: string): ApiCollection | undefined {
    const collection = this.getCollection(id);
    if (!collection) {
      return undefined;
    }
    const copy = this.createCollection(`${collection.name} (copy)`);
    copy.description = collection.description;
    copy.headers = collection.headers.map((row) => ({ ...row, id: createRequest().id }));
    copy.variables = collection.variables.map((row) => ({ ...row, id: createRequest().id }));
    copy.scripts = { ...collection.scripts };
    copy.auth = collection.auth ? JSON.parse(JSON.stringify(collection.auth)) : null;
    const folderMap = new Map<string, string>();
    for (const folder of this.folders.filter((f) => f.collectionId === id)) {
      const clone = createFolder(copy.id, folder.name, folder.parentFolderId ? folderMap.get(folder.parentFolderId) ?? null : null, folder.sortOrder);
      clone.description = folder.description;
      folderMap.set(folder.id, clone.id);
      this.folders.push(clone);
    }
    for (const request of this.requests.filter((r) => r.collectionId === id)) {
      const clone = cloneRequest(request, {
        name: request.name,
        collectionId: copy.id,
        folderId: request.folderId ? folderMap.get(request.folderId) ?? null : null
      });
      this.requests.push(clone);
    }
    this.persist('collections');
    this.onDidChange.fire({ reason: 'folders' });
    this.onDidChange.fire({ reason: 'requests' });
    return copy;
  }

  /* ---------------------------------- folders --------------------------------- */

  createFolder(collectionId: string, name: string, parentFolderId: string | null = null): ApiFolder | undefined {
    if (!this.getCollection(collectionId)) {
      return undefined;
    }
    const siblings = this.folders.filter((f) => f.collectionId === collectionId && f.parentFolderId === parentFolderId);
    const folder = createFolder(collectionId, ensureUniqueName(name, siblings.map((s) => s.name)), parentFolderId, Date.now());
    this.folders.push(folder);
    this.persist('folders');
    return folder;
  }

  updateFolder(id: string, patch: Partial<Pick<ApiFolder, 'name' | 'description' | 'scripts' | 'auth' | 'sortOrder'>>): ApiFolder | undefined {
    const folder = this.getFolder(id);
    if (!folder) {
      return undefined;
    }
    const siblings = this.folders.filter((f) => f.id !== id && f.collectionId === folder.collectionId && f.parentFolderId === folder.parentFolderId);
    const updated: ApiFolder = {
      ...folder,
      ...patch,
      name: patch.name !== undefined ? ensureUniqueName(patch.name, siblings.map((s) => s.name)) : folder.name,
      updatedAt: nowIso()
    };
    this.folders = this.folders.map((f) => (f.id === id ? updated : f));
    this.persist('folders');
    return updated;
  }

  deleteFolder(id: string): boolean {
    const folder = this.getFolder(id);
    if (!folder) {
      return false;
    }
    const folderIds = [id, ...findDescendantFolderIds(this.folders, id)];
    const removedFolderIds = new Set(folderIds);
    this.folders = this.folders.filter((f) => !removedFolderIds.has(f.id));
    this.requests = this.requests.filter((r) => !r.folderId || !removedFolderIds.has(r.folderId));
    this.persist('folders');
    this.onDidChange.fire({ reason: 'requests' });
    return true;
  }

  /* ---------------------------------- requests -------------------------------- */

  createRequest(options: CreateRequestOptions): ApiRequest {
    const request = createRequest(options);
    this.requests.push(request);
    this.persist('requests');
    return request;
  }

  saveRequest(request: ApiRequest): ApiRequest {
    const normalized = normalizeRequest(request);
    const existingIndex = this.requests.findIndex((r) => r.id === normalized.id);
    if (existingIndex === -1) {
      this.requests.push(normalized);
    } else {
      const previous = this.requests[existingIndex];
      if (previous.name !== normalized.name && normalized.collectionId) {
        const siblings = this.requests.filter(
          (r) => r.id !== normalized.id && r.collectionId === normalized.collectionId && r.folderId === normalized.folderId
        );
        normalized.name = ensureUniqueName(normalized.name, siblings.map((r) => r.name));
      }
      this.requests[existingIndex] = normalized;
    }
    this.persist('requests');
    return normalized;
  }

  deleteRequest(id: string): boolean {
    const exists = this.requests.some((r) => r.id === id);
    this.requests = this.requests.filter((r) => r.id !== id);
    if (!exists) {
      return false;
    }
    void this.secrets.deleteByPrefix(`auth:${id}`);
    this.persist('requests');
    return true;
  }

  duplicateRequest(id: string): ApiRequest | undefined {
    const request = this.getRequest(id);
    if (!request) {
      return undefined;
    }
    const siblings = this.requests.filter((r) => r.collectionId === request.collectionId && r.folderId === request.folderId);
    const clone = cloneRequest(request, { name: ensureUniqueName(`${request.name} (copy)`, siblings.map((r) => r.name)) });
    this.requests.push(clone);
    this.persist('requests');
    return clone;
  }

  /** Moves a request into a folder (or the collection root when `folderId` is null). */
  moveRequest(id: string, targetCollectionId: string, targetFolderId: string | null, beforeId?: string): boolean {
    const request = this.getRequest(id);
    const collection = this.getCollection(targetCollectionId);
    if (!request || !collection) {
      return false;
    }
    if (targetFolderId) {
      const folder = this.getFolder(targetFolderId);
      if (!folder || folder.collectionId !== targetCollectionId) {
        return false;
      }
    }
    const siblings = this.requests
      .filter((r) => r.id !== id && r.collectionId === targetCollectionId && r.folderId === targetFolderId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    let sortOrder: number;
    if (beforeId) {
      const index = siblings.findIndex((r) => r.id === beforeId);
      if (index > 0) {
        sortOrder = (siblings[index - 1].sortOrder + siblings[index].sortOrder) / 2;
      } else if (index === 0) {
        sortOrder = siblings[0].sortOrder - 1;
      } else {
        sortOrder = (siblings.at(-1)?.sortOrder ?? Date.now()) + 1;
      }
    } else {
      sortOrder = (siblings.at(-1)?.sortOrder ?? Date.now()) + 1;
    }
    this.requests = this.requests.map((r) =>
      r.id === id ? { ...r, collectionId: targetCollectionId, folderId: targetFolderId, sortOrder, updatedAt: nowIso() } : r
    );
    this.persist('requests');
    return true;
  }

  reorderRequest(id: string, direction: 'up' | 'down'): boolean {
    const request = this.getRequest(id);
    if (!request) {
      return false;
    }
    const siblings = this.requests
      .filter((r) => r.collectionId === request.collectionId && r.folderId === request.folderId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const index = siblings.findIndex((r) => r.id === id);
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (index === -1 || swapWith < 0 || swapWith >= siblings.length) {
      return false;
    }
    const a = siblings[index];
    const b = siblings[swapWith];
    this.requests = this.requests.map((r) => {
      if (r.id === a.id) {
        return { ...r, sortOrder: b.sortOrder };
      }
      if (r.id === b.id) {
        return { ...r, sortOrder: a.sortOrder };
      }
      return r;
    });
    this.persist('requests');
    return true;
  }

  /** Bulk import of collections (used by ImportExportService). */
  async importCollections(payload: { collections: ApiCollection[]; folders: ApiFolder[]; requests: ApiRequest[] }, secretValues: Record<string, string> = {}): Promise<{ collections: number; requests: number }> {
    const idMap = new Map<string, string>();
    for (const collection of payload.collections) {
      const existing = this.collections.map((c) => c.name);
      const created = createCollection(ensureUniqueName(collection.name, existing), collection.sortOrder);
      idMap.set(collection.id, created.id);
      created.description = collection.description;
      created.headers = collection.headers;
      created.variables = collection.variables;
      created.scripts = collection.scripts;
      created.auth = collection.auth ?? null;
      this.collections.push(created);
    }
    const folderMap = new Map<string, string>();
    const foldersToImport = [...payload.folders].sort((a, b) => {
      const depth = (f: ApiFolder) => (f.parentFolderId ? 1 : 0);
      return depth(a) - depth(b);
    });
    for (const folder of foldersToImport) {
      const collectionId = idMap.get(folder.collectionId);
      if (!collectionId) {
        continue;
      }
      const created = createFolder(
        collectionId,
        ensureUniqueName(folder.name, this.folders.filter((f) => f.collectionId === collectionId).map((f) => f.name)),
        folder.parentFolderId ? folderMap.get(folder.parentFolderId) ?? null : null,
        folder.sortOrder
      );
      created.description = folder.description;
      created.scripts = folder.scripts;
      folderMap.set(folder.id, created.id);
      this.folders.push(created);
    }
    for (const request of payload.requests) {
      const collectionId = idMap.get(request.collectionId ?? '');
      if (!collectionId) {
        continue;
      }
      const created = normalizeRequest(request, {
        collectionId,
        folderId: request.folderId ? folderMap.get(request.folderId) ?? null : null
      });
      created.id = request.id;
      this.requests.push(created);
    }
    for (const [key, value] of Object.entries(secretValues)) {
      await this.secrets.store(key, value);
    }
    this.persist('collections');
    this.onDidChange.fire({ reason: 'folders' });
    this.onDidChange.fire({ reason: 'requests' });
    return { collections: payload.collections.length, requests: payload.requests.length };
  }

  /** Replaces the whole dataset (used by import of a workspace backup / clearing). */
  replaceAll(collections: ApiCollection[], folders: ApiFolder[], requests: ApiRequest[]): void {
    this.collections = collections.map(normalizeCollection);
    const known = new Set(this.collections.map((c) => c.id));
    this.folders = folders
      .map((f) => normalizeFolder(f, f?.collectionId ?? ''))
      .filter((f): f is ApiFolder => !!f && known.has(f.collectionId));
    this.requests = requests.map((r) => normalizeRequest(r)).filter((r) => !r.collectionId || known.has(r.collectionId));
    this.persist('collections');
    this.onDidChange.fire({ reason: 'folders' });
    this.onDidChange.fire({ reason: 'requests' });
  }

  private persist(reason: CollectionChangeReason): void {
    this.storage.queueWrite({
      collections: this.collections,
      folders: this.folders,
      requests: this.requests
    });
    this.onDidChange.fire({ reason });
  }

  /** Flushes pending writes (called on deactivate). */
  flush(): Promise<void> {
    return this.storage.flush({
      collections: this.collections,
      folders: this.folders,
      requests: this.requests
    });
  }
}

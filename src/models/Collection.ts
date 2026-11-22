import type { ApiCollection, ApiFolder, ApiRequest, CollectionNodeBase } from './types';
import { defaultAuth, defaultScripts, newId, nowIso, normalizeAuth, normalizeScripts } from './Request';

export function createCollection(name = 'New Collection', sortOrder = Date.now()): ApiCollection {
  const timestamp = nowIso();
  return {
    kind: 'collection',
    id: newId(),
    name,
    description: '',
    sortOrder,
    createdAt: timestamp,
    updatedAt: timestamp,
    headers: [],
    auth: null,
    scripts: defaultScripts(),
    variables: []
  };
}

export function createFolder(collectionId: string, name = 'New Folder', parentFolderId: string | null = null, sortOrder = Date.now()): ApiFolder {
  const timestamp = nowIso();
  return {
    kind: 'folder',
    id: newId(),
    name,
    description: '',
    sortOrder,
    createdAt: timestamp,
    updatedAt: timestamp,
    collectionId,
    parentFolderId,
    scripts: defaultScripts(),
    auth: null
  };
}

export function normalizeCollection(input: unknown): ApiCollection {
  const base = createCollection();
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const collection: ApiCollection = {
    ...base,
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : base.sortOrder,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    headers: Array.isArray(raw.headers)
      ? raw.headers
          .filter((h): h is Record<string, unknown> => !!h && typeof h === 'object')
          .map((h) => ({
            id: typeof h.id === 'string' ? h.id : newId(),
            enabled: h.enabled === undefined ? true : Boolean(h.enabled),
            key: typeof h.key === 'string' ? h.key : '',
            value: typeof h.value === 'string' ? h.value : '',
            description: typeof h.description === 'string' ? h.description : undefined
          }))
      : [],
    auth: raw.auth ? normalizeAuth(raw.auth) : null,
    scripts: normalizeScripts(raw.scripts),
    variables: Array.isArray(raw.variables)
      ? raw.variables
          .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
          .map((v) => ({
            id: typeof v.id === 'string' ? v.id : newId(),
            enabled: v.enabled === undefined ? true : Boolean(v.enabled),
            key: typeof v.key === 'string' ? v.key : '',
            value: typeof v.value === 'string' ? v.value : '',
            description: typeof v.description === 'string' ? v.description : undefined
          }))
      : []
  };
  return collection;
}

export function normalizeFolder(input: unknown, fallbackCollectionId: string): ApiFolder | null {
  const raw = (input && typeof input === 'object' ? input : null) as Record<string, unknown> | null;
  if (!raw) {
    return null;
  }
  const collectionId = typeof raw.collectionId === 'string' && raw.collectionId ? raw.collectionId : fallbackCollectionId;
  const base = createFolder(collectionId);
  return {
    ...base,
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
    description: typeof raw.description === 'string' ? raw.description : '',
    sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : base.sortOrder,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    parentFolderId: typeof raw.parentFolderId === 'string' && raw.parentFolderId ? raw.parentFolderId : null,
    scripts: normalizeScripts(raw.scripts),
    auth: raw.auth ? normalizeAuth(raw.auth) : null
  };
}

export interface TreeNode {
  type: 'collection' | 'folder' | 'request';
  id: string;
  name: string;
  children: TreeNode[];
  request?: ApiRequest;
  folder?: ApiFolder;
  collection?: ApiCollection;
}

/**
 * Builds the collection → folder(s) → request tree used by the sidebar and the client sidebar.
 * Ordering is stable: nodes sort by `sortOrder`, then by name.
 */
export function buildTree(collections: ApiCollection[], folders: ApiFolder[], requests: ApiRequest[]): TreeNode[] {
  const byName = (a: { name: string; sortOrder: number }, b: { name: string; sortOrder: number }) =>
    a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

  const collectionsSorted = [...collections].sort(byName);
  return collectionsSorted.map((collection) => {
    const collectionFolders = folders.filter((f) => f.collectionId === collection.id).sort(byName);
    const collectionRequests = requests.filter((r) => r.collectionId === collection.id).sort(byName);

    const buildFolder = (folder: ApiFolder, ancestors: Set<string>): TreeNode => {
      const nextAncestors = new Set(ancestors).add(folder.id);
      const childFolders = collectionFolders
        .filter((f) => f.parentFolderId === folder.id && !nextAncestors.has(f.id))
        .map((f) => buildFolder(f, nextAncestors));
      const childRequests = collectionRequests
        .filter((r) => r.folderId === folder.id)
        .map((request) => ({ type: 'request' as const, id: request.id, name: request.name, children: [], request }));
      return { type: 'folder', id: folder.id, name: folder.name, children: [...childFolders, ...childRequests], folder };
    };

    const rootFolders = collectionFolders
      .filter((f) => !f.parentFolderId || !collectionFolders.some((candidate) => candidate.id === f.parentFolderId))
      .map((f) => buildFolder(f, new Set([collection.id])));
    const rootRequests = collectionRequests
      .filter((r) => !r.folderId || !collectionFolders.some((f) => f.id === r.folderId))
      .map((request) => ({ type: 'request' as const, id: request.id, name: request.name, children: [], request }));

    return {
      type: 'collection' as const,
      id: collection.id,
      name: collection.name,
      children: [...rootFolders, ...rootRequests],
      collection
    };
  });
}

export function findDescendantFolderIds(folders: ApiFolder[], folderId: string): string[] {
  const result: string[] = [];
  const queue = [folderId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const folder of folders) {
      if (folder.parentFolderId === current && !result.includes(folder.id)) {
        result.push(folder.id);
        queue.push(folder.id);
      }
    }
  }
  return result;
}

export function findDescendantRequestIds(requests: ApiRequest[], folderIds: string[]): string[] {
  const set = new Set(folderIds);
  return requests.filter((r) => r.folderId && set.has(r.folderId)).map((r) => r.id);
}

export function ensureUniqueName(name: string, existing: string[]): string {
  const trimmed = name.trim() || 'Untitled';
  if (!existing.includes(trimmed)) {
    return trimmed;
  }
  let counter = 2;
  while (existing.includes(`${trimmed} ${counter}`)) {
    counter++;
  }
  return `${trimmed} ${counter}`;
}

export function touchNode<T extends CollectionNodeBase>(node: T): T {
  return { ...node, updatedAt: nowIso() };
}

export function defaultCollectionAuth() {
  return defaultAuth();
}

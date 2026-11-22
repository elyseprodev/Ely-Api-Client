import type {
  ApiEnvironment,
  ApiRequest,
  AuthConfig,
  BodyConfig,
  HttpMethod,
  KeyValueRow,
  RequestSettings,
  RequestScripts
} from './types';
import { HTTP_METHODS, newKeyValueRow } from './types';

/** Generates a unique identifier without depending on Node's crypto module (shared with tests). */
export function newId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return g.crypto.randomUUID();
  }
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${hex()}-${hex()}-${hex()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultAuth(): AuthConfig {
  return { type: 'none' };
}

export function defaultBody(): BodyConfig {
  return { type: 'none', raw: '', form: [] };
}

export function defaultScripts(): RequestScripts {
  return { preRequest: '', tests: '' };
}

export function defaultSettings(): RequestSettings {
  return {};
}

export interface CreateRequestOptions {
  method?: HttpMethod;
  url?: string;
  name?: string;
  collectionId?: string;
  folderId?: string | null;
  sortOrder?: number;
}

/**
 * Creates a fully-formed request. Every collection of rows is initialised so that the UI can
 * render the request builder without defensive checks.
 */
export function createRequest(options: CreateRequestOptions = {}): ApiRequest {
  const timestamp = nowIso();
  return {
    id: newId(),
    name: options.name ?? 'Untitled Request',
    method: options.method ?? 'GET',
    url: options.url ?? '',
    params: [],
    headers: [],
    auth: defaultAuth(),
    body: defaultBody(),
    scripts: defaultScripts(),
    settings: defaultSettings(),
    description: '',
    collectionId: options.collectionId,
    folderId: options.folderId ?? null,
    sortOrder: options.sortOrder ?? Date.now(),
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function createEnvironment(name = 'New Environment'): ApiEnvironment {
  const timestamp = nowIso();
  return { id: newId(), name, variables: [], createdAt: timestamp, updatedAt: timestamp };
}

export function isHttpMethod(value: unknown): value is HttpMethod {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value.toUpperCase());
}

function coerceRows(rows: unknown): KeyValueRow[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    .map((row) =>
      newKeyValueRow({
        id: typeof row.id === 'string' ? row.id : undefined,
        enabled: row.enabled === undefined ? true : Boolean(row.enabled),
        key: typeof row.key === 'string' ? row.key : '',
        value: row.value === undefined || row.value === null ? '' : String(row.value),
        description: typeof row.description === 'string' ? row.description : undefined
      })
    );
}

/**
 * Normalises possibly-untrusted request data (imported files, stale storage, webview messages)
 * into a valid `ApiRequest`. Never throws; unknown values fall back to safe defaults.
 */
export function normalizeRequest(input: unknown, base: Partial<ApiRequest> = {}): ApiRequest {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const merged: ApiRequest = {
    ...createRequest({
      method: isHttpMethod(raw.method) ? (raw.method.toUpperCase() as HttpMethod) : base.method,
      url: typeof raw.url === 'string' ? raw.url : base.url,
      name: typeof raw.name === 'string' ? raw.name : base.name,
      collectionId: typeof raw.collectionId === 'string' ? raw.collectionId : base.collectionId,
      folderId:
        raw.folderId === null || typeof raw.folderId === 'string'
          ? (raw.folderId as string | null)
          : (base.folderId ?? null),
      sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : base.sortOrder
    }),
    ...base
  };

  if (typeof raw.id === 'string' && raw.id) {
    merged.id = raw.id;
  }
  merged.params = coerceRows(raw.params);
  merged.headers = coerceRows(raw.headers);
  merged.auth = normalizeAuth(raw.auth ?? base.auth);
  merged.body = normalizeBody(raw.body ?? base.body);
  merged.scripts = normalizeScripts(raw.scripts ?? base.scripts);
  merged.settings = normalizeSettings(raw.settings ?? base.settings);
  merged.description = typeof raw.description === 'string' ? raw.description : (base.description ?? '');
  merged.createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : (base.createdAt ?? nowIso());
  merged.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : (base.updatedAt ?? nowIso());
  return merged;
}

export function normalizeAuth(input: unknown): AuthConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const type = typeof raw.type === 'string' ? raw.type : 'none';
  const auth: AuthConfig = { type: 'none' };
  switch (type) {
    case 'bearer':
      auth.type = 'bearer';
      auth.token = typeof raw.token === 'string' ? raw.token : '';
      auth.prefix = typeof raw.prefix === 'string' ? raw.prefix : undefined;
      break;
    case 'basic':
      auth.type = 'basic';
      auth.username = typeof raw.username === 'string' ? raw.username : '';
      auth.password = typeof raw.password === 'string' ? raw.password : '';
      break;
    case 'api-key':
      auth.type = 'api-key';
      auth.keyName = typeof raw.keyName === 'string' ? raw.keyName : '';
      auth.keyValue = typeof raw.keyValue === 'string' ? raw.keyValue : '';
      auth.keyLocation = raw.keyLocation === 'query' ? 'query' : 'header';
      break;
    case 'oauth2': {
      auth.type = 'oauth2';
      const o = (raw.oauth2 && typeof raw.oauth2 === 'object' ? raw.oauth2 : {}) as Record<string, unknown>;
      auth.oauth2 = {
        grantType:
          o.grantType === 'password' || o.grantType === 'authorization-code'
            ? (o.grantType as 'password' | 'authorization-code')
            : 'client-credentials',
        tokenUrl: typeof o.tokenUrl === 'string' ? o.tokenUrl : '',
        clientId: typeof o.clientId === 'string' ? o.clientId : '',
        clientSecret: typeof o.clientSecret === 'string' ? o.clientSecret : '',
        scope: typeof o.scope === 'string' ? o.scope : '',
        username: typeof o.username === 'string' ? o.username : '',
        password: typeof o.password === 'string' ? o.password : '',
        clientAuth: o.clientAuth === 'body' ? 'body' : 'header',
        accessToken: typeof o.accessToken === 'string' ? o.accessToken : undefined,
        refreshToken: typeof o.refreshToken === 'string' ? o.refreshToken : undefined,
        tokenExpiresAt: typeof o.tokenExpiresAt === 'number' ? o.tokenExpiresAt : undefined
      };
      break;
    }
    default:
      auth.type = 'none';
  }
  if (typeof raw.secretRef === 'string' && raw.secretRef) {
    auth.secretRef = raw.secretRef;
  }
  return auth;
}

export function normalizeBody(input: unknown): BodyConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const allowed: BodyConfig['type'][] = ['none', 'json', 'text', 'xml', 'form-urlencoded', 'form-data', 'binary', 'graphql'];
  const type = allowed.includes(raw.type as BodyConfig['type']) ? (raw.type as BodyConfig['type']) : 'none';
  const form = Array.isArray(raw.form)
    ? raw.form
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map((row) => ({
          ...newKeyValueRow({
            id: typeof row.id === 'string' ? row.id : undefined,
            enabled: row.enabled === undefined ? true : Boolean(row.enabled),
            key: typeof row.key === 'string' ? row.key : '',
            value: row.value === undefined || row.value === null ? '' : String(row.value)
          }),
          type: row.type === 'file' ? ('file' as const) : ('text' as const),
          filePath: typeof row.filePath === 'string' ? row.filePath : undefined
        }))
    : [];
  return {
    type,
    raw: typeof raw.raw === 'string' ? raw.raw : '',
    form,
    binaryPath: typeof raw.binaryPath === 'string' ? raw.binaryPath : undefined
  };
}

export function normalizeScripts(input: unknown): RequestScripts {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return {
    preRequest: typeof raw.preRequest === 'string' ? raw.preRequest : '',
    tests: typeof raw.tests === 'string' ? raw.tests : ''
  };
}

export function normalizeSettings(input: unknown): RequestSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const settings: RequestSettings = {};
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs >= 0) {
    settings.timeoutMs = raw.timeoutMs;
  }
  if (typeof raw.followRedirects === 'boolean') {
    settings.followRedirects = raw.followRedirects;
  }
  if (typeof raw.maxRedirects === 'number' && Number.isFinite(raw.maxRedirects)) {
    settings.maxRedirects = Math.max(0, Math.min(20, Math.trunc(raw.maxRedirects)));
  }
  if (typeof raw.verifyTls === 'boolean') {
    settings.verifyTls = raw.verifyTls;
  }
  return settings;
}

export interface RequestCloneOptions {
  name?: string;
  collectionId?: string;
  folderId?: string | null;
  regenerateIds?: boolean;
}

/** Deep-clones a request, assigning fresh ids to the request and its rows. */
export function cloneRequest(request: ApiRequest, options: RequestCloneOptions = {}): ApiRequest {
  const clone = JSON.parse(JSON.stringify(request)) as ApiRequest;
  clone.id = newId();
  clone.name = options.name ?? `${request.name} (copy)`;
  clone.collectionId = options.collectionId ?? request.collectionId;
  clone.folderId = options.folderId === undefined ? request.folderId : options.folderId;
  clone.createdAt = nowIso();
  clone.updatedAt = clone.createdAt;
  clone.sortOrder = Date.now();
  for (const row of [...clone.params, ...clone.headers, ...clone.body.form]) {
    row.id = newKeyValueRow().id;
  }
  return clone;
}

/** Strips credentials from an auth config, returning a shallow-cloned config. */
export function redactAuth(auth: AuthConfig): AuthConfig {
  const redacted: AuthConfig = { ...auth };
  if (redacted.token) {
    redacted.token = '';
  }
  if (redacted.password) {
    redacted.password = '';
  }
  if (redacted.keyValue) {
    redacted.keyValue = '';
  }
  const hadSecretRef = !!redacted.secretRef;
  if (redacted.oauth2) {
    redacted.oauth2 = { ...redacted.oauth2, clientSecret: '', accessToken: undefined, refreshToken: undefined, password: '' };
  }
  if (!hadSecretRef) {
    // keep as-is; caller decides whether to drop the auth object entirely
  }
  return redacted;
}

export function redactEnvironment(environment: ApiEnvironment): ApiEnvironment {
  return {
    ...environment,
    variables: environment.variables.map((variable) =>
      variable.secret ? { ...variable, value: '' } : { ...variable }
    )
  };
}

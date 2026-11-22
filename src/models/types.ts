/**
 * Core domain model shared by the extension host, the webview and the tests.
 *
 * This file is deliberately free of VS Code and Node imports: the webview receives the same
 * shapes over `postMessage` and mirrors the normalisation rules in `media/scripts/core.js`
 * (`Ely.models`). Keep the two in sync when changing a shape.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Methods that must never carry a request body (RFC 9110). */
export const BODYLESS_METHODS: readonly string[] = ['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'];

export const BODY_TYPES = ['none', 'json', 'text', 'xml', 'form-urlencoded', 'form-data', 'binary', 'graphql'] as const;
export type BodyType = (typeof BODY_TYPES)[number];

export const AUTH_TYPES = ['none', 'bearer', 'basic', 'api-key', 'oauth2'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export type ApiKeyLocation = 'header' | 'query';

export interface KeyValueRow {
  /** Stable client-side identifier used for DOM keying. */
  id: string;
  enabled: boolean;
  key: string;
  value: string;
  description?: string;
}

export interface FormDataRow extends KeyValueRow {
  type: 'text' | 'file';
  /** Absolute path or workspace-relative path for file rows. Never exposed in history. */
  filePath?: string;
}

export interface AuthConfig {
  type: AuthType;
  /** Bearer token or API key value. Kept out of collection files when `secretRef` is used. */
  token?: string;
  username?: string;
  password?: string;
  keyName?: string;
  keyValue?: string;
  keyLocation?: ApiKeyLocation;
  oauth2?: OAuth2Config;
  /**
   * When set, the real credential lives in SecretStorage under this key and `token` /
   * `password` / `keyValue` are placeholders that the webview displays as masked.
   */
  secretRef?: string;
  /** Prefix added before a bearer token (default "Bearer "). */
  prefix?: string;
}

export interface OAuth2Config {
  grantType: 'client-credentials' | 'password' | 'authorization-code';
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  username?: string;
  password?: string;
  clientAuth: 'header' | 'body';
  /** Populated after a token request; never exported. */
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}

export interface BodyConfig {
  type: BodyType;
  /** Raw text payload for json/text/xml/graphql. */
  raw: string;
  /** Form data rows (form-urlencoded uses `value`, form-data supports files). */
  form: FormDataRow[];
  /** Absolute or workspace-relative path of a binary upload. */
  binaryPath?: string;
}

export interface RequestSettings {
  /** Per-request timeout in ms. `undefined` inherits the workspace setting, 0 disables. */
  timeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  verifyTls?: boolean;
}

export interface RequestScripts {
  preRequest: string;
  tests: string;
}

export interface ApiRequest {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValueRow[];
  headers: KeyValueRow[];
  auth: AuthConfig;
  body: BodyConfig;
  scripts: RequestScripts;
  settings: RequestSettings;
  description: string;
  /** Id of the collection this request belongs to (absent for unsaved scratch requests). */
  collectionId?: string;
  folderId?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionNodeBase {
  id: string;
  name: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiFolder extends CollectionNodeBase {
  kind: 'folder';
  collectionId: string;
  parentFolderId: string | null;
  /** Scripts executed for every request in the folder (inherited tests). */
  scripts: RequestScripts;
  auth?: AuthConfig | null;
}

export interface ApiCollection extends CollectionNodeBase {
  kind: 'collection';
  /** Collection level defaults inherited by requests. */
  headers: KeyValueRow[];
  auth: AuthConfig | null;
  scripts: RequestScripts;
  variables: KeyValueRow[];
}

export interface EnvironmentVariable {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  secret?: boolean;
  /** Runtime-only hint for the UI: whether a secret value is stored. Never persisted. */
  hasValue?: boolean;
}

export interface ApiEnvironment {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
  createdAt: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id: string;
  requestId?: string;
  name: string;
  method: HttpMethod;
  url: string;
  statusCode?: number;
  statusText?: string;
  durationMs?: number;
  sizeBytes?: number;
  error?: string;
  /** Full request snapshot minus secrets, used by "reopen". */
  request?: ApiRequest;
  collectionId?: string;
  createdAt: string;
}

export type ResponseBodyKind = 'json' | 'text' | 'html' | 'xml' | 'image' | 'binary';

export interface ResponseHeader {
  key: string;
  value: string;
}

export interface ResponseCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  raw: string;
}

export interface ApiResponse {
  requestId?: string;
  status: number;
  statusText: string;
  httpVersion: string;
  headers: ResponseHeader[];
  bodyKind: ResponseBodyKind;
  /** Body text. Binary bodies are base64 encoded and flagged by `bodyEncoding`. */
  body: string;
  bodyEncoding?: 'utf8' | 'base64' | 'latin1';
  /** Total size of the received body in bytes (before display truncation). */
  sizeBytes: number;
  /** True when the body was truncated for display. */
  truncated: boolean;
  durationMs: number;
  redirects: { status: number; location: string }[];
  finalUrl: string;
  contentType: string;
  encoding?: string;
  cookies: ResponseCookie[];
  /** Timings in milliseconds, all relative to the start of the request. */
  timings: {
    start: number;
    firstByte?: number;
    download?: number;
    total: number;
  };
  receivedAt: string;
}

export interface TestResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  stack?: string;
  line?: number;
}

export interface TestRunSummary {
  results: TestResult[];
  passed: number;
  failed: number;
  durationMs: number;
  console: ScriptConsoleEntry[];
  error?: string;
}

export interface ScriptConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

export interface HttpErrorDetails {
  kind:
    | 'invalid-url'
    | 'blocked-address'
    | 'timeout'
    | 'cancelled'
    | 'dns'
    | 'connection'
    | 'tls'
    | 'too-large'
    | 'too-many-redirects'
    | 'file'
    | 'unknown';
  message: string;
  code?: string;
  hint?: string;
}

export interface SendRequestResult {
  requestId: string;
  response?: ApiResponse;
  tests?: TestRunSummary;
  error?: HttpErrorDetails;
  /** Resolved request actually sent (variables expanded, secrets redacted). */
  resolved: { method: HttpMethod; url: string; headers: ResponseHeader[] };
  durationMs: number;
}

export const WS_PROTOCOLS = ['ws:', 'wss:'] as const;

export interface WebSocketMessage {
  id: string;
  direction: 'in' | 'out' | 'system';
  type: 'text' | 'binary' | 'event';
  data: string;
  sizeBytes: number;
  timestamp: number;
}

export type WebSocketState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';

export interface WebSocketSessionInfo {
  id: string;
  url: string;
  state: WebSocketState;
  openedAt?: number;
  closedAt?: number;
  closeCode?: number;
  closeReason?: string;
  error?: string;
  messages: WebSocketMessage[];
}

export interface WebviewSettings {
  defaultMethod: HttpMethod;
  timeout: number;
  followRedirects: 'follow' | 'never';
  maxRedirects: number;
  verifyTls: boolean;
  maxDisplaySize: number;
  prettyPrint: boolean;
  theme: 'auto' | 'dark' | 'light';
  confirmBeforeDelete: boolean;
  historyEnabled: boolean;
  historyLimit: number;
  scriptTimeoutMs: number;
  allowPrivateNetwork: boolean;
  websocketMaxMessages: number;
}

export interface AppSnapshot {
  version: number;
  collections: ApiCollection[];
  folders: ApiFolder[];
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  activeEnvironmentId: string | null;
  history: HistoryEntry[];
  settings: WebviewSettings;
  tools: { websocket: WebSocketSessionInfo | null };
}

export function isBodylessMethod(method: HttpMethod): boolean {
  return BODYLESS_METHODS.includes(method);
}

/** Headers that must never be persisted verbatim to history or exported collections. */
export const SENSITIVE_HEADER_PATTERN =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|x-csrf-token|x-xsrf-token|token)$/i;

export function newKeyValueRow(partial: Partial<KeyValueRow> = {}): KeyValueRow {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2, 10),
    enabled: partial.enabled ?? true,
    key: partial.key ?? '',
    value: partial.value ?? '',
    description: partial.description
  };
}

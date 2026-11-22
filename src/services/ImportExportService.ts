import type {
  ApiCollection,
  ApiEnvironment,
  ApiFolder,
  ApiRequest,
  AuthConfig,
  BodyConfig,
  HttpMethod,
  KeyValueRow
} from '../models/types';
import { HTTP_METHODS, isBodylessMethod, newKeyValueRow } from '../models/types';
import { createCollection, createFolder, normalizeFolder } from '../models/Collection';
import { createRequest, newId, normalizeRequest, nowIso, redactAuth } from '../models/Request';
import { normalizeEnvironment } from '../models/Environment';
import { assertJsonSize, SecurityError, validateName } from '../security/SecurityValidator';
import { parseQueryString } from '../utils/UrlValidator';

/**
 * Import/export of collections, environments, Postman collections, OpenAPI documents and cURL
 * commands.
 *
 * The native format is documented in docs/import-export.md. Importers normalise every node through
 * the same validators used by the UI, so malformed input cannot corrupt stored data. Imported
 * scripts are preserved as text but never executed automatically.
 */

export const NATIVE_FORMAT = 'ely-api-client';
export const NATIVE_SCHEMA_VERSION = 1;

export interface NativeExportFile {
  format: typeof NATIVE_FORMAT;
  schemaVersion: number;
  exportedAt: string;
  generator: string;
  collections?: ApiCollection[];
  folders?: ApiFolder[];
  requests?: ApiRequest[];
  environments?: ApiEnvironment[];
}

export interface ImportResult {
  format: 'native' | 'postman' | 'openapi' | 'environment' | 'curl';
  collections: ApiCollection[];
  folders: ApiFolder[];
  requests: ApiRequest[];
  environments: ApiEnvironment[];
  warnings: string[];
  /** Secret values extracted during import (never written to files by us). */
  secrets: Record<string, string>;
  summary: string;
}

export interface ExportOptions {
  /** Mask credentials and strip scripts. */
  sanitizeSecrets?: boolean;
  includeScripts?: boolean;
}

const GENERATOR = 'ElyApiClient';

/* ------------------------------------------------------------------------------------------------
 * Export
 * ---------------------------------------------------------------------------------------------- */

/** Removes test/pre-request scripts from an export when the user opts out. */
function stripScripts<T extends { scripts?: { preRequest: string; tests: string } }>(node: T): T {
  if (!node.scripts) {
    return node;
  }
  return { ...node, scripts: { preRequest: '', tests: '' } };
}

/** Removes credentials from a request for sanitised exports. */
function sanitizeRequestForExport(request: ApiRequest): ApiRequest {
  if (!request.auth || request.auth.type === 'none') {
    return request;
  }
  const auth: AuthConfig = { ...redactAuth(request.auth) };
  if (request.auth.secretRef) {
    auth.secretRef = undefined;
  }
  return { ...request, auth };
}

export function exportNative(
  input: { collections?: ApiCollection[]; folders?: ApiFolder[]; requests?: ApiRequest[]; environments?: ApiEnvironment[] },
  options: ExportOptions = {}
): NativeExportFile {
  const sanitize = options.sanitizeSecrets === true;
  const mapRequest = (request: ApiRequest): ApiRequest => {
    let result = sanitize ? sanitizeRequestForExport(request) : request;
    if (options.includeScripts === false) {
      result = stripScripts(result);
    }
    return result;
  };
  return {
    format: NATIVE_FORMAT,
    schemaVersion: NATIVE_SCHEMA_VERSION,
    exportedAt: nowIso(),
    generator: GENERATOR,
    collections: input.collections,
    folders: input.folders,
    requests: input.requests?.map(mapRequest),
    environments: input.environments
  };
}

/** Serialises an export object with a stable, readable layout. */
export function serialiseExport(data: NativeExportFile): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/* ------------------------------------------------------------------------------------------------
 * Validation helpers
 * ---------------------------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asMethod(value: unknown, fallback: HttpMethod = 'GET'): HttpMethod {
  const upper = typeof value === 'string' ? value.toUpperCase() : '';
  return (HTTP_METHODS as readonly string[]).includes(upper) ? (upper as HttpMethod) : fallback;
}

function emptyImport(format: ImportResult['format']): ImportResult {
  return { format, collections: [], folders: [], requests: [], environments: [], warnings: [], secrets: {}, summary: '' };
}

/* ------------------------------------------------------------------------------------------------
 * Native import
 * ---------------------------------------------------------------------------------------------- */

export function importNative(text: string, options: { maxBytes: number }): ImportResult {
  assertJsonSize(text, options.maxBytes, 'Import file');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SecurityError(`The file is not valid JSON: ${(error as Error).message}`, 'invalid-input');
  }
  const root = asRecord(parsed);
  if (!root) {
    throw new SecurityError('The file must contain a JSON object.', 'invalid-input');
  }
  const result = emptyImport('native');

  if (root.format !== NATIVE_FORMAT) {
    throw new SecurityError(`Expected "format": "${NATIVE_FORMAT}".`, 'invalid-input');
  }
  if (typeof root.schemaVersion === 'number' && root.schemaVersion > NATIVE_SCHEMA_VERSION) {
    result.warnings.push(
      `The file uses schema version ${root.schemaVersion} but this version of ElyApiClient supports ${NATIVE_SCHEMA_VERSION}. Unsupported fields were ignored.`
    );
  }

  const collections = Array.isArray(root.collections) ? root.collections : [];
  const folders = Array.isArray(root.folders) ? root.folders : [];
  const requests = Array.isArray(root.requests) ? root.requests : [];
  const environments = Array.isArray(root.environments) ? root.environments : [];

  for (const raw of collections) {
    const collection = createCollection();
    const record = asRecord(raw);
    if (!record) {
      continue;
    }
    collection.id = typeof record.id === 'string' && record.id ? record.id : collection.id;
    collection.name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Imported Collection';
    collection.description = typeof record.description === 'string' ? record.description : '';
    collection.headers = Array.isArray(record.headers) ? (record.headers as KeyValueRow[]) : [];
    collection.variables = Array.isArray(record.variables) ? (record.variables as KeyValueRow[]) : [];
    collection.scripts = { preRequest: '', tests: '' };
    result.collections.push(collection);
  }
  const collectionIds = new Set(result.collections.map((c) => c.id));

  for (const raw of folders) {
    const record = asRecord(raw);
    if (!record) {
      continue;
    }
    const collectionId = typeof record.collectionId === 'string' ? record.collectionId : '';
    if (!collectionIds.has(collectionId)) {
      result.warnings.push(`Folder "${String(record.name ?? '?')}" references an unknown collection and was skipped.`);
      continue;
    }
    const folder = normalizeFolder(record, collectionId);
    if (folder) {
      folder.scripts = { preRequest: '', tests: '' };
      result.folders.push(folder);
    }
  }

  for (const raw of requests) {
    const record = asRecord(raw);
    if (!record) {
      continue;
    }
    const collectionId = typeof record.collectionId === 'string' ? record.collectionId : undefined;
    if (collectionId && !collectionIds.has(collectionId)) {
      result.warnings.push(`Request "${String(record.name ?? '?')}" references an unknown collection and was skipped.`);
      continue;
    }
    const request = normalizeRequest(record, { collectionId });
    request.scripts = { preRequest: '', tests: '' };
    result.requests.push(request);
  }

  for (const raw of environments) {
    const environment = normalizeEnvironment(raw);
    for (const variable of environment.variables) {
      if (variable.secret && variable.value) {
        result.secrets[`env:${environment.id}:${variable.id}`] = variable.value;
        variable.value = '';
      }
    }
    result.environments.push(environment);
  }

  result.summary = `${result.collections.length} collection(s), ${result.requests.length} request(s), ${result.environments.length} environment(s)`;
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * Postman v2.1 import
 * ---------------------------------------------------------------------------------------------- */

interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[] | string;
  path?: string[] | string;
  query?: { key?: string; value?: string; disabled?: boolean; description?: string }[];
  variable?: unknown[];
}

interface PostmanBody {
  mode?: string;
  raw?: string;
  urlencoded?: { key?: string; value?: string; disabled?: boolean; description?: string }[];
  formdata?: { key?: string; value?: string; type?: string; src?: string | string[]; disabled?: boolean }[];
  file?: { src?: string };
  graphql?: { query?: string; variables?: string };
  options?: { raw?: { language?: string } };
}

interface PostmanItem {
  name?: string;
  item?: PostmanItem[];
  request?: string | { method?: string; url?: PostmanUrl | string; header?: { key?: string; value?: string; disabled?: boolean; description?: string }[]; body?: PostmanBody; auth?: Record<string, unknown>; description?: string };
  auth?: Record<string, unknown>;
  event?: { listen?: string; script?: { exec?: string[] | string } }[];
  variable?: { key?: string; value?: unknown }[];
}

function postmanUrlToRecord(url: PostmanUrl | string | undefined): { raw: string; query: { key: string; value: string; enabled: boolean }[] } {
  if (!url) {
    return { raw: '', query: [] };
  }
  if (typeof url === 'string') {
    return { raw: url, query: parseQueryString(url).map((row) => ({ ...row, enabled: true })) };
  }
  let raw = url.raw ?? '';
  if (!raw) {
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host ?? '';
    const path = Array.isArray(url.path) ? url.path.join('/') : url.path ?? '';
    raw = `${url.protocol ? `${url.protocol}://` : ''}${host}${path ? `/${path.replace(/^\//, '')}` : ''}`;
  }
  return {
    raw,
    query: (url.query ?? []).map((row) => ({ key: row.key ?? '', value: row.value ?? '', enabled: !row.disabled }))
  };
}

function postmanAuthToAuth(input: Record<string, unknown> | undefined): AuthConfig {
  const type = typeof input?.type === 'string' ? input.type : 'none';
  const values = Array.isArray(input?.[type as string]) ? (input?.[type as string] as { key?: string; value?: unknown }[]) : [];
  const get = (key: string) => {
    const found = values.find((entry) => entry.key === key);
    return found?.value === undefined ? undefined : String(found.value);
  };
  switch (type) {
    case 'bearer':
      return { type: 'bearer', token: get('token') ?? '' };
    case 'basic':
      return { type: 'basic', username: get('username') ?? '', password: get('password') ?? '' };
    case 'apikey':
      return {
        type: 'api-key',
        keyName: get('key') ?? '',
        keyValue: get('value') ?? '',
        keyLocation: get('in') === 'query' ? 'query' : 'header'
      };
    case 'oauth2':
      return {
        type: 'oauth2',
        oauth2: {
          grantType: 'client-credentials',
          tokenUrl: get('accessTokenUrl') ?? '',
          clientId: get('clientId') ?? '',
          clientSecret: get('clientSecret') ?? '',
          scope: get('scope') ?? '',
          clientAuth: 'header'
        }
      };
    default:
      return { type: 'none' };
  }
}

function postmanBodyToBody(body: PostmanBody | undefined): BodyConfig {
  if (!body || !body.mode) {
    return { type: 'none', raw: '', form: [] };
  }
  switch (body.mode) {
    case 'raw': {
      const language = body.options?.raw?.language;
      const type: BodyConfig['type'] = language === 'xml' ? 'xml' : language === 'json' ? 'json' : 'text';
      return { type, raw: body.raw ?? '', form: [] };
    }
    case 'urlencoded':
      return {
        type: 'form-urlencoded',
        raw: '',
        form: (body.urlencoded ?? []).map((row) => ({
          ...newKeyValueRow({ key: row.key ?? '', value: row.value ?? '' }),
          enabled: !row.disabled,
          type: 'text' as const
        }))
      };
    case 'formdata':
      return {
        type: 'form-data',
        raw: '',
        form: (body.formdata ?? []).map((row) => ({
          ...newKeyValueRow({ key: row.key ?? '', value: row.value ?? '' }),
          enabled: !row.disabled,
          type: row.type === 'file' ? ('file' as const) : ('text' as const),
          filePath: row.src ? (Array.isArray(row.src) ? row.src.join(',') : row.src) : undefined
        }))
      };
    case 'file':
      return { type: 'binary', raw: '', form: [], binaryPath: body.file?.src ?? undefined };
    case 'graphql':
      return {
        type: 'graphql',
        raw: JSON.stringify({ query: body.graphql?.query ?? '', variables: safeJson(body.graphql?.variables) }),
        form: []
      };
    default:
      return { type: 'none', raw: '', form: [] };
  }
}

function safeJson(text: string | undefined): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function postmanScripts(events: PostmanItem['event']): { preRequest: string; tests: string } {
  const joinScript = (script: { exec?: string[] | string } | undefined) =>
    !script ? '' : Array.isArray(script.exec) ? script.exec.join('\n') : script.exec ?? '';
  return {
    preRequest: joinScript(events?.find((event) => event.listen === 'prerequest')?.script),
    tests: joinScript(events?.find((event) => event.listen === 'test')?.script)
  };
}

export function importPostman(text: string, options: { maxBytes: number; keepScripts?: boolean }): ImportResult {
  assertJsonSize(text, options.maxBytes, 'Postman collection');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SecurityError(`The Postman collection is not valid JSON: ${(error as Error).message}`, 'invalid-input');
  }
  const root = asRecord(parsed);
  const info = asRecord(root?.info);
  if (!root || !info) {
    throw new SecurityError('This does not look like a Postman collection (missing "info").', 'invalid-input');
  }
  if (!Array.isArray(root.item)) {
    throw new SecurityError('The Postman collection has no "item" array.', 'invalid-input');
  }
  const result = emptyImport('postman');
  const collection = createCollection(typeof info.name === 'string' && info.name.trim() ? info.name.trim() : 'Imported Postman Collection');
  collection.description = typeof info.description === 'string' ? info.description : '';
  for (const variable of Array.isArray(root.variable) ? root.variable : []) {
    const record = asRecord(variable);
    if (record && typeof record.key === 'string') {
      collection.variables.push(newKeyValueRow({ key: record.key, value: record.value === undefined ? '' : String(record.value) }));
    }
  }
  collection.auth = root.auth ? postmanAuthToAuth(root.auth as Record<string, unknown>) : null;
  result.collections.push(collection);

  const walk = (items: PostmanItem[], parentFolderId: string | null, depth: number) => {
    if (depth > 10) {
      result.warnings.push('Postman folders nested deeper than 10 levels were flattened.');
      return;
    }
    for (const item of items) {
      if (Array.isArray(item.item)) {
        const folder = createFolder(collection.id, typeof item.name === 'string' ? item.name : 'Folder', parentFolderId);
        folder.auth = item.auth ? postmanAuthToAuth(item.auth) : null;
        result.folders.push(folder);
        walk(item.item, folder.id, depth + 1);
        continue;
      }
      if (!item.request) {
        continue;
      }
      const requestData = typeof item.request === 'string' ? { url: item.request } : item.request;
      const { raw, query } = postmanUrlToRecord(requestData.url);
      const request = createRequest({
        method: asMethod(requestData.method),
        url: raw,
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : raw || 'Request',
        collectionId: collection.id,
        folderId: parentFolderId
      });
      request.params = query.map((row) => newKeyValueRow({ key: row.key, value: row.value, enabled: row.enabled }));
      request.headers = (requestData.header ?? []).map((header) =>
        newKeyValueRow({ key: header.key ?? '', value: header.value ?? '', enabled: !header.disabled, description: header.description })
      );
      request.auth = requestData.auth ? postmanAuthToAuth(requestData.auth) : { type: 'none' };
      request.body = postmanBodyToBody(requestData.body);
      const scripts = postmanScripts(item.event);
      if (options.keepScripts !== false) {
        request.scripts = scripts;
      } else if (scripts.tests || scripts.preRequest) {
        result.warnings.push(`Scripts on "${request.name}" were not imported.`);
      }
      request.description = typeof requestData.description === 'string' ? requestData.description : '';
      if (isBodylessMethod(request.method) && request.body.type !== 'none') {
        result.warnings.push(`"${request.name}" is ${request.method} but had a body; the body was ignored.`);
      }
      result.requests.push(request);
    }
  };
  walk(root.item as PostmanItem[], null, 0);
  result.summary = `Postman collection "${collection.name}" with ${result.requests.length} request(s)`;
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * OpenAPI import
 * ---------------------------------------------------------------------------------------------- */

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: { name?: string; in?: string; required?: boolean; schema?: Record<string, unknown>; example?: unknown }[];
  requestBody?: {
    content?: Record<string, { schema?: Record<string, unknown>; example?: unknown }>;
    required?: boolean;
  };
  tags?: string[];
  security?: unknown[];
}

function openApiServerUrl(document: Record<string, unknown>): string {
  const servers = Array.isArray(document.servers) ? document.servers : [];
  const first = asRecord(servers[0]);
  if (first && typeof first.url === 'string') {
    return first.url.replace(/\/$/, '');
  }
  const host = document.host;
  const basePath = document.basePath;
  const schemes = document.schemes;
  if (typeof host === 'string') {
    const scheme = Array.isArray(schemes) && typeof schemes[0] === 'string' ? schemes[0] : 'https';
    return `${scheme}://${host}${typeof basePath === 'string' ? basePath : ''}`.replace(/\/$/, '');
  }
  return 'http://localhost';
}

function sampleFromSchema(schema: Record<string, unknown> | undefined, depth = 0): unknown {
  if (!schema || depth > 4) {
    return undefined;
  }
  if (Array.isArray(schema.enum) && schema.enum.length) {
    return schema.enum[0];
  }
  const type = typeof schema.type === 'string' ? schema.type : Array.isArray(schema.type) ? undefined : undefined;
  switch (type) {
    case 'object': {
      const properties = asRecord(schema.properties) ?? {};
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties).slice(0, 50)) {
        const sample = sampleFromSchema(asRecord(value) ?? undefined, depth + 1);
        result[key] = sample === undefined ? null : sample;
      }
      return result;
    }
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'string':
      return typeof schema.format === 'string' && schema.format === 'date-time' ? '1970-01-01T00:00:00Z' : 'string';
    default:
      if (schema.properties) {
        return sampleFromSchema({ ...schema, type: 'object' }, depth + 1);
      }
      return undefined;
  }
}

export function importOpenApi(text: string, options: { maxBytes: number }): ImportResult {
  assertJsonSize(text, options.maxBytes, 'OpenAPI document');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SecurityError(
      `Only JSON OpenAPI documents are supported (YAML support is planned). ${(error as Error).message}`,
      'invalid-input'
    );
  }
  const document = asRecord(parsed);
  if (!document || (!document.openapi && !document.swagger)) {
    throw new SecurityError('This does not look like an OpenAPI document (missing "openapi" or "swagger").', 'invalid-input');
  }
  const info = asRecord(document.info) ?? {};
  const title = typeof info.title === 'string' && info.title.trim() ? info.title.trim() : 'Imported API';
  const version = typeof info.version === 'string' ? info.version : '';
  const result = emptyImport('openapi');
  const collection = createCollection(version ? `${title} ${version}` : title);
  collection.description = typeof info.description === 'string' ? info.description : '';
  result.collections.push(collection);
  const baseUrl = openApiServerUrl(document);

  const paths = asRecord(document.paths) ?? {};
  const methodNames = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
  for (const [path, pathItemRaw] of Object.entries(paths)) {
    const pathItem = asRecord(pathItemRaw);
    if (!pathItem) {
      continue;
    }
    for (const method of methodNames) {
      const operation = asRecord(pathItem[method]) as OpenApiOperation | null;
      if (!operation) {
        continue;
      }
      const request = createRequest({
        method: asMethod(method),
        url: `${baseUrl}${path}`,
        name: operation.summary || operation.operationId || `${method.toUpperCase()} ${path}`,
        collectionId: collection.id
      });
      request.description = operation.description ?? '';
      request.params = (operation.parameters ?? [])
        .filter((param) => param.in === 'query' && param.name)
        .map((param) => newKeyValueRow({ key: param.name ?? '', value: param.example === undefined ? '' : String(param.example), enabled: Boolean(param.required) }));
      request.headers = (operation.parameters ?? [])
        .filter((param) => param.in === 'header' && param.name)
        .map((param) => newKeyValueRow({ key: param.name ?? '', value: param.example === undefined ? '' : String(param.example), enabled: Boolean(param.required) }));
      const jsonContent = operation.requestBody?.content?.['application/json'];
      if (jsonContent) {
        const sample = jsonContent.example ?? sampleFromSchema(jsonContent.schema);
        request.body = {
          type: 'json',
          raw: sample === undefined ? '' : JSON.stringify(sample, null, 2),
          form: []
        };
      }
      result.requests.push(request);
    }
  }
  result.summary = `OpenAPI "${title}" with ${result.requests.length} operation(s)`;
  if (typeof text === 'string' && text.trim().startsWith('{') === false) {
    result.warnings.push('The document did not start with "{" — YAML documents must be converted to JSON first.');
  }
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * cURL import
 * ---------------------------------------------------------------------------------------------- */

/** Parses a shell-style command line into tokens (single quotes, double quotes, backslashes). */
export function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let hasContent = false;
  const text = input.trim().replace(/^\$\s*/, '').replace(/\\\r?\n/g, ' ');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === '\\' && quote === '"' && i + 1 < text.length) {
        i++;
        const next = text[i];
        current += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasContent = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasContent || current) {
        tokens.push(current);
        current = '';
        hasContent = false;
      }
      continue;
    }
    if (char === '\\' && i + 1 < text.length) {
      i++;
      current += text[i];
      hasContent = true;
      continue;
    }
    current += char;
    hasContent = true;
  }
  if (current || hasContent) {
    tokens.push(current);
  }
  return tokens;
}

export function importCurl(command: string): ImportResult {
  const tokens = tokenizeCommandLine(command);
  if (tokens[0] !== 'curl') {
    throw new SecurityError('The command must start with "curl".', 'invalid-input');
  }
  const result = emptyImport('curl');
  const collection = createCollection('Imported cURL');
  result.collections.push(collection);

  let method: HttpMethod | undefined;
  let url = '';
  const headers: KeyValueRow[] = [];
  let data: string | undefined;
  const dataUrlEncoded: string[] = [];
  const formFields: string[] = [];
  let isForm = false;
  let bodyJson = false;
  let auth: AuthConfig = { type: 'none' };

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const next = () => tokens[++i];
    switch (token) {
      case '-X':
      case '--request':
        method = asMethod(next());
        break;
      case '-H':
      case '--header': {
        const raw = next() ?? '';
        const separator = raw.indexOf(':');
        if (separator > 0) {
          headers.push(newKeyValueRow({ key: raw.slice(0, separator).trim(), value: raw.slice(separator + 1).trim() }));
        }
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
        data = next() ?? '';
        if (data.trim().startsWith('{') || data.trim().startsWith('[')) {
          bodyJson = true;
        }
        break;
      case '--data-urlencode':
        dataUrlEncoded.push(next() ?? '');
        break;
      case '-F':
      case '--form': {
        isForm = true;
        formFields.push(next() ?? '');
        break;
      }
      case '-u':
      case '--user': {
        const credentials = next() ?? '';
        const separator = credentials.indexOf(':');
        auth = {
          type: 'basic',
          username: separator === -1 ? credentials : credentials.slice(0, separator),
          password: separator === -1 ? '' : credentials.slice(separator + 1)
        };
        break;
      }
      case '-A':
      case '--user-agent':
        next();
        break;
      case '-b':
      case '--cookie':
        headers.push(newKeyValueRow({ key: 'Cookie', value: next() ?? '' }));
        break;
      case '-o':
      case '--output':
      case '--max-time':
      case '--connect-timeout':
      case '--retry':
        next();
        break;
      case '-L':
      case '--location':
      case '-s':
      case '--silent':
      case '-k':
      case '--insecure':
      case '-i':
      case '--include':
      case '-v':
      case '--verbose':
      case '--compressed':
      case '--globoff':
        break;
      default:
        if (!token.startsWith('-') && !url) {
          url = token;
        }
        break;
    }
  }

  if (!url) {
    throw new SecurityError('The cURL command does not contain a URL.', 'invalid-input');
  }

  const parsedUrl = parseQueryString(url);
  const request = createRequest({
    method: method ?? (data !== undefined || isForm || dataUrlEncoded.length ? 'POST' : 'GET'),
    url,
    name: `${method ?? 'GET'} ${new URL(url.startsWith('http') ? url : `http://${url}`).pathname}`,
    collectionId: collection.id
  });
  request.name = validateName(request.name, 'Request name');
  request.params = parsedUrl.map((row) => newKeyValueRow({ key: row.key, value: row.value }));
  request.headers = headers;
  request.auth = auth;

  const contentType = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value.toLowerCase() ?? '';
  if (isForm) {
    request.body = {
      type: 'form-data',
      raw: '',
      form: formFields.map((field) => {
        const separator = field.indexOf('=');
        const key = separator === -1 ? field : field.slice(0, separator);
        const value = separator === -1 ? '' : field.slice(separator + 1);
        if (value.startsWith('@')) {
          return { ...newKeyValueRow({ key, value: '' }), type: 'file' as const, filePath: value.slice(1) };
        }
        return { ...newKeyValueRow({ key, value }), type: 'text' as const };
      })
    };
  } else if (dataUrlEncoded.length) {
    request.body = {
      type: 'form-urlencoded',
      raw: '',
      form: dataUrlEncoded.map((pair) => {
        const separator = pair.indexOf('=');
        return { ...newKeyValueRow({ key: separator === -1 ? pair : pair.slice(0, separator), value: separator === -1 ? '' : pair.slice(separator + 1) }), type: 'text' as const };
      })
    };
  } else if (data !== undefined) {
    const type: BodyConfig['type'] = bodyJson || contentType.includes('json') ? 'json' : contentType.includes('xml') ? 'xml' : 'text';
    request.body = { type, raw: data, form: [] };
  }
  result.requests.push(request);
  result.summary = `cURL command with ${result.requests.length} request(s)`;
  return result;
}

/* ------------------------------------------------------------------------------------------------
 * Environment import/export
 * ---------------------------------------------------------------------------------------------- */

export function exportEnvironments(environments: ApiEnvironment[], options: ExportOptions = {}): NativeExportFile {
  const sanitize = options.sanitizeSecrets !== false;
  const exported = environments.map((environment) => ({
    ...environment,
    variables: environment.variables.map((variable) => (sanitize && variable.secret ? { ...variable, value: '' } : { ...variable }))
  }));
  return {
    format: NATIVE_FORMAT,
    schemaVersion: NATIVE_SCHEMA_VERSION,
    exportedAt: nowIso(),
    generator: GENERATOR,
    environments: exported
  };
}

/* ------------------------------------------------------------------------------------------------
 * cURL export
 * ---------------------------------------------------------------------------------------------- */

/** Builds a copy-pasteable cURL command for a request (credentials excluded). */
export function toCurl(request: ApiRequest, resolvedUrl?: string): string {
  const url = (resolvedUrl ?? request.url).replace(/"/g, '\\"');
  const parts = [`curl -X ${request.method} "${url}"`];
  for (const header of request.headers) {
    if (!header.enabled || !header.key.trim() || /^(authorization|cookie)$/i.test(header.key.trim())) {
      continue;
    }
    parts.push(`  -H "${header.key}: ${header.value.replace(/"/g, '\\"')}"`);
  }
  if (!isBodylessMethod(request.method)) {
    if (request.body.type === 'json' || request.body.type === 'text' || request.body.type === 'xml') {
      parts.push(`  -d '${request.body.raw.replace(/'/g, `'\\''`)}'`);
    } else if (request.body.type === 'form-urlencoded') {
      for (const row of request.body.form.filter((entry) => entry.enabled)) {
        parts.push(`  --data-urlencode "${row.key}=${row.value}"`);
      }
    } else if (request.body.type === 'form-data') {
      for (const row of request.body.form.filter((entry) => entry.enabled)) {
        parts.push(row.type === 'file' ? `  -F "${row.key}=@${row.filePath ?? ''}"` : `  -F "${row.key}=${row.value}"`);
      }
    }
  }
  return parts.join(' \\\n');
}

/** Facade used by the extension controller; keeps all format knowledge in one place. */
export class ImportExportService {
  import(text: string, options: { maxBytes: number; format?: ImportResult['format'] }): ImportResult {
    return importFile(text, options);
  }

  exportNative: typeof exportNative = exportNative;
  exportEnvironments: typeof exportEnvironments = exportEnvironments;
  serialise = serialiseExport;
  toCurl: typeof toCurl = toCurl;
  detectFormat: typeof detectFormat = detectFormat;
}

/* ------------------------------------------------------------------------------------------------
 * Format detection
 * ---------------------------------------------------------------------------------------------- */

export function detectFormat(text: string): ImportResult['format'] | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('curl ')) {
    return 'curl';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  if (!root) {
    return null;
  }
  if (root.format === NATIVE_FORMAT) {
    return Array.isArray(root.environments) && !Array.isArray(root.collections) && !Array.isArray(root.requests)
      ? 'environment'
      : 'native';
  }
  if (root.info && (root as { item?: unknown }).item !== undefined) {
    return 'postman';
  }
  if (root.openapi || root.swagger) {
    return 'openapi';
  }
  return null;
}

export function importFile(text: string, options: { maxBytes: number; format?: ImportResult['format'] }): ImportResult {
  const format = options.format ?? detectFormat(text);
  if (!format) {
    throw new SecurityError(
      'Unrecognised file format. Supported formats: ElyApiClient JSON, Postman collection v2.x, OpenAPI 3.x JSON and cURL commands.',
      'invalid-input'
    );
  }
  switch (format) {
    case 'postman':
      return importPostman(text, options);
    case 'openapi':
      return importOpenApi(text, options);
    case 'curl':
      return importCurl(text);
    case 'environment':
    case 'native':
    default:
      return importNative(text, options);
  }
}

export { newId };

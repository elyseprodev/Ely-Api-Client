import type { ApiEnvironment, EnvironmentVariable, HistoryEntry } from './types';
import { SENSITIVE_HEADER_PATTERN } from './types';
import { newId, nowIso, redactAuth } from './Request';

export function createEnvironment(name = 'New Environment'): ApiEnvironment {
  const timestamp = nowIso();
  return { id: newId(), name, variables: [], createdAt: timestamp, updatedAt: timestamp };
}

export function createVariable(key = '', value = '', secret = false): EnvironmentVariable {
  return { id: newId(), key, value, enabled: true, secret };
}

/* ------------------------------------------------------------------------------------------------
 * Variable substitution
 * ---------------------------------------------------------------------------------------------- */

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.\-$]+)\s*\}\}/g;
const MAX_RECURSION = 10;

export interface VariableScope {
  /** Variables from the selected environment. */
  environment?: Record<string, string>;
  /** Collection level variables. */
  collection?: Record<string, string>;
  /** Runtime variables created by pre-request scripts. */
  runtime?: Record<string, string>;
  /** Values known only to the host (secret environment values). Never sent to the webview. */
  secrets?: Record<string, string>;
}

export interface ResolveOptions {
  /** When true, occurrences of unresolved variables are left untouched. */
  keepUnresolved?: boolean;
  /** Values that must be masked in any error/echo output. */
  maskValues?: string[];
}

export interface ResolveResult {
  value: string;
  used: string[];
  unresolved: string[];
}

function lookup(name: string, scope: VariableScope): string | undefined {
  const candidates: (Record<string, string> | undefined)[] = [scope.runtime, scope.secrets, scope.environment, scope.collection];
  for (const source of candidates) {
    if (source && Object.prototype.hasOwnProperty.call(source, name)) {
      return source[name];
    }
  }
  return undefined;
}

/**
 * Resolves `{{variable}}` placeholders. Supports nested variables (a variable value may itself
 * contain placeholders) up to a bounded depth to avoid infinite recursion. Unknown variables are
 * left untouched (or blanked) and reported.
 */
export function resolveVariables(input: string, scope: VariableScope, options: ResolveOptions = {}): ResolveResult {
  const used = new Set<string>();
  const unresolved = new Set<string>();
  let current = input;

  for (let depth = 0; depth < MAX_RECURSION; depth++) {
    let changed = false;
    current = current.replace(VARIABLE_PATTERN, (match, rawName: string) => {
      const name = rawName.trim();
      const value = lookup(name, scope);
      if (value === undefined) {
        unresolved.add(name);
        return options.keepUnresolved === false ? '' : match;
      }
      used.add(name);
      if (value.includes('{{')) {
        changed = true;
      }
      return value;
    });
    if (!changed) {
      break;
    }
  }
  return { value: current, used: [...used], unresolved: [...unresolved] };
}

/** Extracts all variable names referenced in a string. */
export function extractVariables(input: string): string[] {
  const names = new Set<string>();
  for (const match of input.matchAll(VARIABLE_PATTERN)) {
    names.add(match[1].trim());
  }
  return [...names];
}

/** Builds a resolution scope from an environment, keeping secret values in a separate map. */
export function scopeFromEnvironment(
  environment: ApiEnvironment | undefined,
  collectionVars?: EnvironmentVariable[] | Record<string, string>
): VariableScope {
  const scope: VariableScope = { environment: {}, secrets: {} };
  if (environment) {
    for (const variable of environment.variables) {
      if (!variable.enabled || !variable.key) {
        continue;
      }
      if (variable.secret) {
        scope.secrets![variable.key] = variable.value;
      } else {
        scope.environment![variable.key] = variable.value;
      }
    }
  }
  if (Array.isArray(collectionVars)) {
    scope.collection = {};
    for (const variable of collectionVars) {
      if (variable.enabled && variable.key) {
        scope.collection[variable.key] = variable.value;
      }
    }
  } else if (collectionVars) {
    scope.collection = { ...collectionVars };
  }
  return scope;
}

/** Masks secret values that may have leaked into a resolved string (used for echo views). */
export function maskSecrets(value: string, secretValues: string[]): string {
  let result = value;
  for (const secret of secretValues) {
    if (secret && secret.length >= 3) {
      result = result.split(secret).join('••••••••');
    }
  }
  return result;
}

export function environmentVariableMap(environment: ApiEnvironment | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!environment) {
    return map;
  }
  for (const variable of environment.variables) {
    if (variable.enabled && variable.key) {
      map[variable.key] = variable.value;
    }
  }
  return map;
}

export function normalizeEnvironment(input: unknown): ApiEnvironment {
  const base = createEnvironment();
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const variables: EnvironmentVariable[] = Array.isArray(raw.variables)
    ? raw.variables
        .filter((v): v is Record<string, unknown> => !!v && typeof v === 'object')
        .map((v) => ({
          id: typeof v.id === 'string' && v.id ? v.id : newId(),
          key: typeof v.key === 'string' ? v.key : '',
          value: typeof v.value === 'string' ? v.value : v.value === undefined ? '' : String(v.value),
          enabled: v.enabled === undefined ? true : Boolean(v.enabled),
          secret: Boolean(v.secret)
        }))
    : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : base.id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
    variables,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : base.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt
  };
}

/* ------------------------------------------------------------------------------------------------
 * History
 * ---------------------------------------------------------------------------------------------- */

export interface HistoryOptions {
  limit: number;
  retentionDays: number;
  storeRequestBody: boolean;
  redactSensitiveHeaders: boolean;
}

export function normalizeHistoryEntry(input: unknown): HistoryEntry | null {
  const raw = (input && typeof input === 'object' ? input : null) as Record<string, unknown> | null;
  if (!raw || typeof raw.method !== 'string' || typeof raw.url !== 'string') {
    return null;
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    requestId: typeof raw.requestId === 'string' ? raw.requestId : undefined,
    name: typeof raw.name === 'string' ? raw.name : 'Request',
    method: raw.method as HistoryEntry['method'],
    url: raw.url,
    statusCode: typeof raw.statusCode === 'number' ? raw.statusCode : undefined,
    statusText: typeof raw.statusText === 'string' ? raw.statusText : undefined,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
    sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : undefined,
    error: typeof raw.error === 'string' ? raw.error : undefined,
    request: raw.request as HistoryEntry['request'],
    collectionId: typeof raw.collectionId === 'string' ? raw.collectionId : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso()
  };
}

/** Removes credentials from a request snapshot before persisting it to history. */
export function sanitizeRequestForHistory(request: HistoryEntry['request'], options: Pick<HistoryOptions, 'storeRequestBody' | 'redactSensitiveHeaders'>) {
  if (!request) {
    return undefined;
  }
  const clone = JSON.parse(JSON.stringify(request)) as NonNullable<HistoryEntry['request']>;
  clone.auth = redactAuth(clone.auth);
  if (options.redactSensitiveHeaders) {
    clone.headers = clone.headers.map((header) =>
      SENSITIVE_HEADER_PATTERN.test(header.key) ? { ...header, value: '●●●●●●●●' } : header
    );
  }
  if (!options.storeRequestBody) {
    clone.body = { type: 'none', raw: '', form: [] };
  }
  return clone;
}

export function applyHistoryRetention(entries: HistoryEntry[], options: HistoryOptions, now = Date.now()): HistoryEntry[] {
  let result = entries;
  if (options.retentionDays > 0) {
    const cutoff = now - options.retentionDays * 24 * 60 * 60 * 1000;
    result = result.filter((entry) => {
      const time = Date.parse(entry.createdAt);
      return Number.isNaN(time) || time >= cutoff;
    });
  }
  if (options.limit > 0 && result.length > options.limit) {
    result = [...result].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, options.limit);
  }
  return result;
}

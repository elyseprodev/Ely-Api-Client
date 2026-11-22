/**
 * JSON formatting, validation and diffing helpers used by the extension host and tests.
 * The webview has its own copy of the rendering helpers (media/scripts/json.js).
 */

export interface FormatResult {
  ok: boolean;
  formatted: string;
  error?: string;
  /** Byte size of the formatted output. */
  size: number;
}

export interface ParseResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  /** 1-based line/column of the syntax error, when the engine provides it. */
  position?: { line: number; column: number };
}

/**
 * Parses JSON with helpful error positions. Accepts a leading BOM and tolerates empty input as
 * "no value" so callers can present friendlier messages.
 */
export function parseJson(text: string): ParseResult {
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) {
    return { ok: false, error: 'The document is empty.' };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const positionMatch = /position (\d+)/.exec(message);
    let position: { line: number; column: number } | undefined;
    if (positionMatch) {
      const index = Number(positionMatch[1]);
      const upTo = trimmed.slice(0, index);
      const line = upTo.split('\n').length;
      const column = index - upTo.lastIndexOf('\n');
      position = { line, column };
    }
    const lineMatch = /line (\d+) column (\d+)/.exec(message);
    if (lineMatch) {
      position = { line: Number(lineMatch[1]), column: Number(lineMatch[2]) };
    }
    return { ok: false, error: message.replace(/^JSON\.parse: /, ''), position };
  }
}

export function formatJson(text: string, indent = 2): FormatResult {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { ok: false, formatted: text, error: parsed.error, size: Buffer.byteLength(text, 'utf8') };
  }
  const formatted = JSON.stringify(parsed.value, null, indent);
  return { ok: true, formatted, size: Buffer.byteLength(formatted, 'utf8') };
}

export function minifyJson(text: string): FormatResult {
  const parsed = parseJson(text);
  if (!parsed.ok) {
    return { ok: false, formatted: text, error: parsed.error, size: Buffer.byteLength(text, 'utf8') };
  }
  const formatted = JSON.stringify(parsed.value);
  return { ok: true, formatted, size: Buffer.byteLength(formatted, 'utf8') };
}

/** Sorts object keys recursively so two documents can be compared structurally. */
export function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => [key, sortJsonKeys(val)] as const);
    return Object.fromEntries(entries);
  }
  return value;
}

export type JsonPointer = string;

export interface JsonDifference {
  path: JsonPointer;
  kind: 'missing-right' | 'missing-left' | 'type-mismatch' | 'value-mismatch' | 'array-length';
  left?: unknown;
  right?: unknown;
}

/** Compares two JSON values and returns the list of differences (bounded for display safety). */
export function diffJson(left: unknown, right: unknown, limit = 500): JsonDifference[] {
  const differences: JsonDifference[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (differences.length >= limit) {
      return;
    }
    if (a === b) {
      return;
    }
    const typeA = jsonType(a);
    const typeB = jsonType(b);
    if (typeA !== typeB) {
      differences.push({ path, kind: 'type-mismatch', left: a, right: b });
      return;
    }
    if (typeA === 'array') {
      const arrA = a as unknown[];
      const arrB = b as unknown[];
      if (arrA.length !== arrB.length) {
        differences.push({ path, kind: 'array-length', left: arrA.length, right: arrB.length });
      }
      const max = Math.max(arrA.length, arrB.length);
      for (let i = 0; i < max && differences.length < limit; i++) {
        if (i >= arrA.length) {
          differences.push({ path: `${path}/${i}`, kind: 'missing-left', right: arrB[i] });
        } else if (i >= arrB.length) {
          differences.push({ path: `${path}/${i}`, kind: 'missing-right', left: arrA[i] });
        } else {
          walk(arrA[i], arrB[i], `${path}/${i}`);
        }
      }
      return;
    }
    if (typeA === 'object') {
      const objA = a as Record<string, unknown>;
      const objB = b as Record<string, unknown>;
      const keys = new Set([...Object.keys(objA), ...Object.keys(objB)]);
      for (const key of keys) {
        if (differences.length >= limit) {
          return;
        }
        const inA = Object.prototype.hasOwnProperty.call(objA, key);
        const inB = Object.prototype.hasOwnProperty.call(objB, key);
        const childPath = `${path}/${escapePointer(key)}`;
        if (!inB) {
          differences.push({ path: childPath, kind: 'missing-right', left: objA[key] });
        } else if (!inA) {
          differences.push({ path: childPath, kind: 'missing-left', right: objB[key] });
        } else {
          walk(objA[key], objB[key], childPath);
        }
      }
      return;
    }
    differences.push({ path, kind: 'value-mismatch', left: a, right: b });
  };
  walk(left, right, '');
  return differences;
}

function jsonType(value: unknown): 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'other' {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  switch (typeof value) {
    case 'object':
      return 'object';
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    default:
      return 'other';
  }
}

export function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Resolves a JSONPath-like pointer against a parsed document. Supports:
 *  - plain property paths: `data.users`
 *  - array indexes: `users.0.name` or `users[0].name`
 *  - `$` prefix (`$.data.items[2].id`)
 */
export function getByPath(document: unknown, path: string): { found: boolean; value?: unknown } {
  const normalized = path
    .trim()
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1');
  if (!normalized) {
    return { found: true, value: document };
  }
  const segments = normalized.split('.').filter((s) => s !== '');
  let current: unknown = document;
  for (const segment of segments) {
    if (current === null || current === undefined) {
      return { found: false };
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    if (typeof current === 'object') {
      const record = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) {
        return { found: false };
      }
      current = record[segment];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

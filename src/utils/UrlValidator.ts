/**
 * URL validation and query-string helpers.
 *
 * All request URLs sent through the extension are validated here. The rules are intentionally
 * strict: only http(s) (and ws(s) for the WebSocket client) are accepted, credentials embedded in
 * the URL are rejected, and private/loopback targets can be blocked to reduce SSRF risk.
 */

export type UrlKind = 'http' | 'websocket';

export interface UrlValidationOptions {
  kind?: UrlKind;
  allowPrivateNetwork?: boolean;
  /** Hosts (optionally `host:port`) that remain allowed when private network access is off. */
  trustedHosts?: string[];
}

export interface UrlValidationResult {
  valid: boolean;
  url?: URL;
  error?: string;
  code?: 'empty' | 'invalid' | 'protocol' | 'credentials' | 'blocked-host';
  /** True when the target resolves syntactically to a private/loopback/link-local address. */
  privateAddress?: boolean;
}

const PRIVATE_V4 = [
  { cidr: [10, 0, 0, 0], bits: 8 },
  { cidr: [172, 16, 0, 0], bits: 12 },
  { cidr: [192, 168, 0, 0], bits: 16 },
  { cidr: [127, 0, 0, 0], bits: 8 },
  { cidr: [169, 254, 0, 0], bits: 16 },
  { cidr: [0, 0, 0, 0], bits: 8 },
  { cidr: [100, 64, 0, 0], bits: 10 }
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (n > 255) {
      return null;
    }
    value = value * 256 + n;
  }
  return value >>> 0;
}

function isPrivateV4(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) {
    return false;
  }
  return PRIVATE_V4.some(({ cidr, bits }) => {
    const base = ipv4ToInt(cidr.join('.'))!;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ip & mask) === (base & mask);
  });
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain') {
    return true;
  }
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (host.startsWith('fd') || host.startsWith('fc') || host.startsWith('fe80')) {
    return true;
  }
  if (isPrivateV4(host)) {
    return true;
  }
  // Hostnames without a dot are usually intranet hosts (e.g. `api`, `db-server`).
  if (!host.includes('.') && !host.includes(':')) {
    return true;
  }
  return false;
}

function isTrusted(hostname: string, port: string, trusted: string[]): boolean {
  const host = hostname.toLowerCase();
  const withPort = port ? `${host}:${port}` : host;
  return trusted.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized && (normalized === host || normalized === withPort);
  });
}

/** Validates a request URL and reports why it is unusable. */
export function validateUrl(rawUrl: string, options: UrlValidationOptions = {}): UrlValidationResult {
  const kind = options.kind ?? 'http';
  const trimmed = (rawUrl ?? '').trim();
  if (!trimmed) {
    return { valid: false, error: 'The URL is empty.', code: 'empty' };
  }
  if (/\s/.test(trimmed)) {
    return { valid: false, error: 'The URL contains whitespace. Encode spaces as %20.', code: 'invalid' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: 'The URL is not valid. Include a scheme, for example https://api.example.com/users.',
      code: 'invalid'
    };
  }

  const allowedProtocols = kind === 'websocket' ? ['ws:', 'wss:', 'http:', 'https:'] : ['http:', 'https:'];
  if (!allowedProtocols.includes(parsed.protocol)) {
    return {
      valid: false,
      error: `Unsupported protocol "${parsed.protocol}". Use ${allowedProtocols.map((p) => p.replace(':', '')).join(' or ')}.`,
      code: 'protocol',
      url: parsed
    };
  }
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      error: 'Credentials embedded in URLs are not allowed. Use the Authorization tab instead.',
      code: 'credentials',
      url: parsed
    };
  }
  if (!parsed.hostname) {
    return { valid: false, error: 'The URL is missing a host.', code: 'invalid', url: parsed };
  }

  const privateAddress = isPrivateHostname(parsed.hostname);
  if (options.allowPrivateNetwork === false && privateAddress && !isTrusted(parsed.hostname, parsed.port, options.trustedHosts ?? [])) {
    return {
      valid: false,
      error: `Requests to private or loopback addresses are disabled (${parsed.hostname}). Enable "elyApiClient.security.allowPrivateNetwork" or add the host to "elyApiClient.security.trustedHosts".`,
      code: 'blocked-host',
      url: parsed,
      privateAddress
    };
  }

  return { valid: true, url: parsed, privateAddress };
}

/** Splits a URL's existing query string into rows while preserving duplicates. */
export function parseQueryString(url: string): { key: string; value: string }[] {
  const index = url.indexOf('?');
  if (index === -1) {
    return [];
  }
  const hashIndex = url.indexOf('#');
  const query = url.slice(index + 1, hashIndex === -1 ? undefined : hashIndex);
  const result: { key: string; value: string }[] = [];
  const searchParams = new URLSearchParams(query);
  for (const [key, value] of searchParams.entries()) {
    result.push({ key, value });
  }
  // URLSearchParams loses rows such as `?flag` (key with no value); capture those too.
  for (const pair of query.split('&')) {
    if (pair && !pair.includes('=')) {
      result.push({ key: decodeURIComponent(pair.replace(/\+/g, ' ')), value: '' });
    }
  }
  return result;
}

/** Removes the query string (keeping the hash) so query rows can be applied explicitly. */
export function stripQueryString(url: string): string {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex === -1 ? '' : url.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  return (queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex)) + hash;
}

export interface QueryRowInput {
  enabled?: boolean;
  key: string;
  value?: string;
}

/**
 * Builds the final URL by combining the request URL, the user's query rows and any URL-encoded
 * values. Existing query parameters remain unless overridden by an enabled row with the same key.
 */
export function buildUrlWithParams(rawUrl: string, rows: QueryRowInput[], extraParams: QueryRowInput[] = []): string {
  const base = rawUrl.trim();
  if (!base) {
    return base;
  }
  const hashIndex = base.indexOf('#');
  const hash = hashIndex === -1 ? '' : base.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? base : base.slice(0, hashIndex);

  const existing = parseQueryString(withoutHash);
  const serialisedExisting = existing.map((row) => ({ key: row.key, value: row.value }));

  const enabledRows = rows.filter((row) => row.enabled !== false && row.key.trim() !== '');
  const removedKeys = new Set(
    rows.filter((row) => row.enabled === false && row.key.trim() !== '').map((row) => row.key.trim())
  );

  const merged: { key: string; value: string }[] = [];
  for (const row of serialisedExisting) {
    if (removedKeys.has(row.key)) {
      continue;
    }
    const override = enabledRows.find((r) => r.key.trim() === row.key);
    merged.push(override ? { key: row.key, value: override.value ?? '' } : row);
  }
  for (const row of enabledRows) {
    if (!merged.some((m) => m.key === row.key.trim())) {
      merged.push({ key: row.key.trim(), value: row.value ?? '' });
    }
  }
  for (const row of extraParams) {
    if (!merged.some((m) => m.key === row.key)) {
      merged.push({ key: row.key, value: row.value ?? '' });
    }
  }

  const query = merged
    .map((row) => (row.value === '' ? encodeURIComponent(row.key) : `${encodeURIComponent(row.key)}=${encodeURIComponent(row.value)}`))
    .join('&');
  const baseWithoutQuery = stripQueryString(withoutHash);
  return query ? `${baseWithoutQuery}?${query}${hash}` : `${baseWithoutQuery}${hash}`;
}

/** Redacts userinfo and obvious secrets from a URL for logging/display. */
export function displayUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '***';
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

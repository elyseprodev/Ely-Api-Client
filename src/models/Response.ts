import type {
  ApiResponse,
  ApiRequest,
  HttpErrorDetails,
  ResponseBodyKind,
  ResponseCookie,
  ResponseHeader,
  SendRequestResult,
  TestRunSummary
} from './types';

const TEXT_LIKE_APPLICATION_TYPES = [
  'application/json',
  'application/problem+json',
  'application/vnd.api+json',
  'application/javascript',
  'application/xml',
  'application/x-www-form-urlencoded',
  'application/graphql',
  'application/yaml',
  'application/x-yaml',
  'application/ld+json',
  'application/soap+xml'
];

/**
 * Best-effort classification of a response body for the UI. Uses the Content-Type header first
 * and falls back to sniffing the payload when the header is missing or generic.
 */
export function detectBodyKind(contentType: string, body: Buffer, isText: boolean): ResponseBodyKind {
  const type = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!type || type === 'application/octet-stream') {
    const sniffed = sniffContent(body, isText);
    if (sniffed) {
      return sniffed;
    }
  }
  if (type.includes('json') || type.endsWith('+json')) {
    return 'json';
  }
  if (type === 'text/html' || type === 'application/xhtml+xml') {
    return 'html';
  }
  if (type.includes('xml') || type.endsWith('+xml')) {
    return 'xml';
  }
  if (type.startsWith('image/')) {
    return 'image';
  }
  if (type.startsWith('text/') || TEXT_LIKE_APPLICATION_TYPES.includes(type) || type.endsWith('+xml')) {
    return 'text';
  }
  if (type === 'application/pdf' || type.startsWith('audio/') || type.startsWith('video/') || type.startsWith('font/')) {
    return 'binary';
  }
  return isText ? 'text' : 'binary';
}

function sniffContent(body: Buffer, isText: boolean): ResponseBodyKind | null {
  if (body.length >= 8) {
    if (
      body[0] === 0x89 &&
      body[1] === 0x50 &&
      body[2] === 0x4e &&
      body[3] === 0x47
    ) {
      return 'image';
    }
    if (body[0] === 0x47 && body[1] === 0x49 && body[2] === 0x46) {
      return 'image';
    }
    if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) {
      return 'image';
    }
  }
  if (!isText) {
    return null;
  }
  const head = body.subarray(0, 512).toString('utf8').trimStart();
  if (!head) {
    return 'text';
  }
  if (head.startsWith('<')) {
    if (/^<!doctype html/i.test(head) || /^<html[\s>]/i.test(head)) {
      return 'html';
    }
    return 'xml';
  }
  if (head.startsWith('{') || head.startsWith('[')) {
    return 'json';
  }
  return null;
}

/** Determines whether a buffer is valid UTF-8 (so it can be shown as text). */
export function isUtf8(buffer: Buffer): boolean {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    decoder.decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export interface BuildResponseInput {
  status: number;
  statusText: string;
  headers: { key: string; value: string }[];
  rawBody: Buffer;
  durationMs: number;
  timings: ApiResponse['timings'];
  finalUrl: string;
  redirects: { status: number; location: string }[];
  maxDisplaySize: number;
  requestId?: string;
}

/**
 * Converts a raw HTTP exchange into the serialisable `ApiResponse` sent to the webview.
 * Binary payloads are base64 encoded; text payloads larger than `maxDisplaySize` are truncated.
 */
export function buildApiResponse(input: BuildResponseInput): ApiResponse {
  const headers = input.headers.map((h) => ({ key: h.key, value: h.value }));
  const contentType = headerValue(headers, 'content-type') ?? '';
  const text = isUtf8(input.rawBody);
  const bodyKind = detectBodyKind(contentType, input.rawBody, text);
  const truncated = input.rawBody.length > input.maxDisplaySize;
  const limited = truncated ? input.rawBody.subarray(0, input.maxDisplaySize) : input.rawBody;

  let body: string;
  let bodyEncoding: ApiResponse['bodyEncoding'];
  if (bodyKind === 'binary' || bodyKind === 'image' || !text) {
    body = limited.toString('base64');
    bodyEncoding = 'base64';
  } else {
    body = limited.toString('utf8');
    bodyEncoding = 'utf8';
  }

  return {
    requestId: input.requestId,
    status: input.status,
    statusText: input.statusText,
    httpVersion: '1.1',
    headers,
    bodyKind,
    body,
    bodyEncoding,
    sizeBytes: input.rawBody.length,
    truncated,
    durationMs: Math.round(input.durationMs),
    redirects: input.redirects,
    finalUrl: input.finalUrl,
    contentType,
    encoding: headerValue(headers, 'content-encoding'),
    cookies: parseSetCookies(headers),
    timings: input.timings,
    receivedAt: new Date().toISOString()
  };
}

export function headerValue(headers: ResponseHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((h) => h.key.toLowerCase() === lower)?.value;
}

/** Parses `Set-Cookie` headers into structured values without executing any of their content. */
export function parseSetCookies(headers: ResponseHeader[]): ResponseCookie[] {
  const cookies: ResponseCookie[] = [];
  for (const header of headers) {
    if (header.key.toLowerCase() !== 'set-cookie') {
      continue;
    }
    for (const raw of splitCookieHeader(header.value)) {
      const parts = raw.split(';').map((p) => p.trim());
      const [nameValue, ...attributes] = parts;
      if (!nameValue) {
        continue;
      }
      const eq = nameValue.indexOf('=');
      if (eq <= 0) {
        continue;
      }
      const cookie: ResponseCookie = {
        name: nameValue.slice(0, eq).trim(),
        value: nameValue.slice(eq + 1).trim(),
        raw
      };
      for (const attribute of attributes) {
        const [attrName, ...rest] = attribute.split('=');
        const value = rest.join('=').trim();
        switch (attrName.trim().toLowerCase()) {
          case 'domain':
            cookie.domain = value;
            break;
          case 'path':
            cookie.path = value;
            break;
          case 'expires':
            cookie.expires = value;
            break;
          case 'httponly':
            cookie.httpOnly = true;
            break;
          case 'secure':
            cookie.secure = true;
            break;
          case 'samesite':
            cookie.sameSite = value;
            break;
          default:
            break;
        }
      }
      cookies.push(cookie);
    }
  }
  return cookies;
}

function splitCookieHeader(value: string): string[] {
  // Splitting on commas is unsafe inside Expires; split before "name=" after a comma instead.
  const result: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === ',' && /;\s*[A-Za-z0-9_-]+\s*=/.test(current)) {
      result.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) {
    result.push(current);
  }
  return result.map((c) => c.trim()).filter(Boolean);
}

export function emptyTestSummary(): TestRunSummary {
  return { results: [], passed: 0, failed: 0, durationMs: 0, console: [] };
}

export function buildSuccessResult(
  request: ApiRequest,
  response: ApiResponse,
  resolved: SendRequestResult['resolved'],
  tests?: TestRunSummary
): SendRequestResult {
  return {
    requestId: request.id,
    response,
    tests,
    resolved,
    durationMs: response.durationMs
  };
}

export function buildErrorResult(
  request: ApiRequest,
  error: HttpErrorDetails,
  resolved: SendRequestResult['resolved'],
  durationMs: number,
  tests?: TestRunSummary
): SendRequestResult {
  return { requestId: request.id, error, resolved, durationMs, tests };
}

/** Produces a compact human readable summary used in notifications and history. */
export function summariseResponse(response: ApiResponse): string {
  return `${response.status} ${response.statusText} · ${response.durationMs} ms · ${formatBytes(response.sizeBytes)}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
}

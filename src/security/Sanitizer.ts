/**
 * Output sanitisation and redaction helpers.
 *
 * Anything that flows from a remote server (headers, bodies, error messages) or from a user's
 * saved data is considered untrusted. The webview never uses innerHTML with these values; they are
 * rendered with `textContent`. These helpers exist for the places that must produce text (logs,
 * error strings, clipboard exports) and for defence in depth.
 */

import { SENSITIVE_HEADER_PATTERN } from '../models/types';

// eslint-disable-next-line no-control-regex -- stripping ANSI escapes requires matching ESC.
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Removes ANSI escape sequences and control characters that could corrupt terminal output. */
export function stripControlCharacters(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(CONTROL_CHARS, '');
}

/** Escapes text for safe inclusion in HTML (only used for documents we generate ourselves). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERN.test(name.trim());
}

/**
 * Masks a sensitive header value.
 *
 * For credentials with a scheme (`Authorization: Bearer <token>`, `Basic <base64>`) the scheme is
 * kept readable because it is not secret, while the credential itself is fully replaced. Keeping a
 * suffix of the value is intentionally avoided: for short tokens the suffix *is* the secret.
 */
export function maskHeaderValue(value: string): string {
  if (!value) {
    return '';
  }
  const scheme = /^(Bearer|Basic|Digest|Token|ApiKey|OAuth)\s+/i.exec(value);
  if (scheme) {
    return `${scheme[1]} ●●●●●●`;
  }
  return '●●●●●●';
}

export interface RedactionRule {
  pattern: RegExp;
  replacement: string;
}

/** Patterns for credentials that may appear in free-form strings (logs, error messages, URLs). */
const DEFAULT_REDACTIONS: RedactionRule[] = [
  { pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replacement: '$1 ●●●●●●' },
  { pattern: /\b(Basic)\s+[A-Za-z0-9+/=]{8,}/gi, replacement: '$1 ●●●●●●' },
  { pattern: /\b(password|passwd|pwd|secret|client_secret|access_token|refresh_token|api[_-]?key|token)\b\s*[=:]\s*("[^"]*"|'[^']*'|[^\s&,;"']+)/gi, replacement: '$1=●●●●●●' },
  { pattern: /([?&](?:api[_-]?key|access_token|token|secret)=)[^&\s]+/gi, replacement: '$1●●●●●●' },
  { pattern: /\/\/[^/@\s:]+:[^/@\s]+@/g, replacement: '//●●●●●●:●●●●●●@' }
];

/**
 * Redacts credentials from a free-form string. Safe to call on any text before logging.
 */
export function redactSecrets(value: string, extraValues: string[] = []): string {
  if (!value) {
    return value;
  }
  let result = value;
  for (const secret of extraValues) {
    if (secret && secret.length >= 4) {
      result = result.split(secret).join('●●●●●●');
    }
  }
  for (const rule of DEFAULT_REDACTIONS) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/**
 * Produces a log-safe message from an unknown error. Never includes stack frames from user data.
 */
export function sanitizeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(stripControlCharacters(error.message || error.name || 'Unknown error'));
  }
  if (typeof error === 'string') {
    return redactSecrets(stripControlCharacters(error));
  }
  try {
    return redactSecrets(stripControlCharacters(JSON.stringify(error)));
  } catch {
    return 'Unknown error';
  }
}

/**
 * Limits the size of a string before it is sent to the webview, keeping a marker in the middle so
 * users know content was elided.
 */
export function truncateForDisplay(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) {
    return { value, truncated: false };
  }
  const headSize = Math.floor(maxBytes * 0.75);
  const tailSize = Math.max(0, maxBytes - headSize - 64);
  const head = buffer.subarray(0, headSize).toString('utf8');
  const tail = tailSize > 0 ? buffer.subarray(buffer.length - tailSize).toString('utf8') : '';
  return {
    value: `${head}\n\n… ${buffer.length - headSize - tailSize} bytes elided …\n\n${tail}`,
    truncated: true
  };
}

const FORBIDDEN_SCHEMES = ['javascript:', 'data:text/html', 'vbscript:', 'file:'];

/**
 * Validates that a URL taken from a response body is safe to offer as a clickable link in the
 * webview. Only http(s) links are allowed; everything else is rejected.
 */
export function isSafeExternalLink(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (FORBIDDEN_SCHEMES.some((scheme) => lower.startsWith(scheme))) {
    return false;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Sanitises a filename coming from user input or imported data. */
export function sanitizeFilename(name: string, fallback = 'export'): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- control characters must be removed from filenames.
    .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

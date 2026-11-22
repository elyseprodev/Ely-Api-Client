/**
 * Central security policy: validates webview messages, payload sizes and user input before it is
 * persisted or sent over the network.
 */

import type { KeyValueRow } from '../models/types';

export class SecurityError extends Error {
  constructor(
    message: string,
    readonly code: 'payload-too-large' | 'invalid-message' | 'invalid-input' | 'blocked'
  ) {
    super(message);
    this.name = 'SecurityError';
  }
}

export const LIMITS = {
  maxMessageBytes: 32 * 1024 * 1024,
  maxImportedFileBytes: 10 * 1024 * 1024,
  maxRequestNameLength: 200,
  maxUrlLength: 16 * 1024,
  maxHeaderCount: 200,
  maxHeaderValueLength: 32 * 1024,
  maxEnvironmentVariables: 500,
  maxCollectionDepth: 10,
  maxScriptLength: 128 * 1024
} as const;

export interface InboundMessage {
  type: string;
  requestId?: string;
  payload?: unknown;
}

/**
 * Validates the envelope of a message posted from a webview. Returns the typed message or throws a
 * `SecurityError`.
 */
export function validateMessage(raw: unknown, maxBytes = LIMITS.maxMessageBytes): InboundMessage {
  if (raw === null || typeof raw !== 'object') {
    throw new SecurityError('Webview message must be an object.', 'invalid-message');
  }
  const message = raw as Record<string, unknown>;
  if (typeof message.type !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.:-]*$/.test(message.type) || message.type.length > 64) {
    throw new SecurityError('Webview message has an invalid type.', 'invalid-message');
  }
  if (message.requestId !== undefined && typeof message.requestId !== 'string') {
    throw new SecurityError('Message requestId must be a string.', 'invalid-message');
  }
  if (message.payload !== undefined) {
    const size = Buffer.byteLength(JSON.stringify(message.payload) ?? '', 'utf8');
    if (size > maxBytes) {
      throw new SecurityError(`Message payload exceeds the ${maxBytes} byte limit.`, 'payload-too-large');
    }
  }
  return message as unknown as InboundMessage;
}

export function validateName(name: string, label = 'Name'): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    throw new SecurityError(`${label} cannot be empty.`, 'invalid-input');
  }
  if (trimmed.length > LIMITS.maxRequestNameLength) {
    throw new SecurityError(`${label} must be at most ${LIMITS.maxRequestNameLength} characters.`, 'invalid-input');
  }
  return trimmed;
}

export function validateUrlLength(url: string): void {
  if (url.length > LIMITS.maxUrlLength) {
    throw new SecurityError(`URLs must be at most ${LIMITS.maxUrlLength} characters.`, 'invalid-input');
  }
}

/** Validates and normalises an HTTP header name (RFC 7230 token). */
export function validateHeaderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new SecurityError('Header name cannot be empty.', 'invalid-input');
  }
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(trimmed)) {
    throw new SecurityError(`"${trimmed}" is not a valid HTTP header name.`, 'invalid-input');
  }
  return trimmed;
}

export function validateHeaderValue(value: string): string {
  if (value.length > LIMITS.maxHeaderValueLength) {
    throw new SecurityError('Header value is too long.', 'invalid-input');
  }
  // eslint-disable-next-line no-control-regex -- NUL must be detected to block header injection.
  if (/[\r\n\u0000]/.test(value)) {
    throw new SecurityError('Header values must not contain line breaks (header injection).', 'invalid-input');
  }
  return value;
}

export function validateHeaders(rows: KeyValueRow[]): void {
  const enabled = rows.filter((row) => row.enabled && row.key.trim());
  if (enabled.length > LIMITS.maxHeaderCount) {
    throw new SecurityError(`At most ${LIMITS.maxHeaderCount} headers are allowed per request.`, 'invalid-input');
  }
  for (const row of enabled) {
    validateHeaderName(row.key);
    validateHeaderValue(row.value);
  }
}

export function validateScriptLength(script: string): void {
  if (script.length > LIMITS.maxScriptLength) {
    throw new SecurityError('Scripts must be at most 128 KB.', 'invalid-input');
  }
}

/**
 * Bounds the number of rows the UI may create in one message to prevent memory abuse.
 */
export function validateRowCount(rows: unknown[], label: string, max = 1000): void {
  if (rows.length > max) {
    throw new SecurityError(`Too many ${label} (limit ${max}).`, 'payload-too-large');
  }
}

/** Rejects payloads whose serialised size exceeds a limit (used for imports). */
export function assertJsonSize(text: string, maxBytes: number, label = 'File'): void {
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new SecurityError(`${label} exceeds the ${(maxBytes / 1024 / 1024).toFixed(1)} MB import limit.`, 'payload-too-large');
  }
}

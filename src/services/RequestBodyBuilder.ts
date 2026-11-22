import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ApiRequest, BodyConfig } from '../models/types';
import { isBodylessMethod } from '../models/types';
import { HttpRequestError, type HttpRequestBody } from './HttpClient';
import type { VariableResolver } from '../utils/VariableResolver';
import { resolveUserPath } from '../utils/paths';

/**
 * Turns the declarative `BodyConfig` into something the HTTP engine can send.
 * Returns `undefined` for bodyless methods so the request never carries an unexpected body.
 */

export interface BuiltBody {
  body?: HttpRequestBody;
  /** Headers implied by the body type (Content-Type etc). */
  headers: { key: string; value: string }[];
  contentType?: string;
  /** Human readable description used in the request echo. */
  summary: string;
  warnings: string[];
}

const CONTENT_TYPES: Partial<Record<BodyConfig['type'], string>> = {
  json: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
  graphql: 'application/json'
};

function escapeBoundaryValue(value: string): string {
  return value.replace(/\r/g, '').replace(/\n/g, '');
}

export async function buildRequestBody(
  request: ApiRequest,
  resolver: VariableResolver,
  options: { verifyFileAccess?: (filePath: string) => void; workspaceRoot?: string | null } = {}
): Promise<BuiltBody> {
  const warnings: string[] = [];
  if (isBodylessMethod(request.method)) {
    if (request.body.type !== 'none') {
      warnings.push(`${request.method} requests do not send a request body; the Body tab is ignored.`);
    }
    return { headers: [], summary: 'No body', warnings };
  }

  const config = request.body;
  switch (config.type) {
    case 'none':
      return { headers: [], summary: 'No body', warnings };
    case 'json': {
      const resolved = resolver.resolve(config.raw);
      const trimmed = resolved.value.trim();
      const payload = trimmed === '' ? '' : trimmed;
      return {
        body: { data: payload, contentType: 'application/json' },
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        contentType: 'application/json',
        summary: `JSON (${Buffer.byteLength(payload)} bytes)`,
        warnings
      };
    }
    case 'graphql': {
      const resolved = resolver.resolve(config.raw);
      let payload = resolved.value.trim();
      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        if (typeof parsed.query === 'string' && parsed.variables === undefined) {
          parsed.variables = {};
          payload = JSON.stringify(parsed);
        }
      } catch {
        // Treat raw GraphQL documents as `{ "query": "..." }`.
        payload = JSON.stringify({ query: resolved.value, variables: {} });
      }
      return {
        body: { data: payload, contentType: 'application/json' },
        headers: [{ key: 'Content-Type', value: 'application/json' }],
        contentType: 'application/json',
        summary: `GraphQL (${Buffer.byteLength(payload)} bytes)`,
        warnings
      };
    }
    case 'text':
    case 'xml': {
      const resolved = resolver.resolve(config.raw);
      const contentType = CONTENT_TYPES[config.type] ?? 'text/plain';
      return {
        body: { data: resolved.value, contentType },
        headers: [{ key: 'Content-Type', value: `${contentType}; charset=utf-8` }],
        contentType,
        summary: `${config.type} (${Buffer.byteLength(resolved.value)} bytes)`,
        warnings
      };
    }
    case 'form-urlencoded': {
      const rows = config.form.filter((row) => row.enabled && row.key.trim());
      const params = new URLSearchParams();
      for (const row of rows) {
        params.append(resolver.resolve(row.key).value, resolver.resolve(row.value).value);
      }
      const payload = params.toString();
      return {
        body: { data: payload, contentType: 'application/x-www-form-urlencoded' },
        headers: [{ key: 'Content-Type', value: 'application/x-www-form-urlencoded' }],
        contentType: 'application/x-www-form-urlencoded',
        summary: `Form URL-encoded (${rows.length} fields)`,
        warnings
      };
    }
    case 'form-data': {
      const boundary = `----ElyApiClientBoundary${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
      const parts: Buffer[] = [];
      const rows = config.form.filter((row) => row.enabled && row.key.trim());
      for (const row of rows) {
        const name = resolver.resolve(row.key).value;
        if (row.type === 'file' && row.filePath) {
          const absolute = resolveUserPath(row.filePath, options.workspaceRoot);
          options.verifyFileAccess?.(absolute);
          let content: Buffer;
          try {
            content = await fs.promises.readFile(absolute);
          } catch (error) {
            throw new HttpRequestError({
              kind: 'file',
              message: `Could not read "${row.filePath}": ${(error as Error).message}`
            });
          }
          const filename = path.basename(absolute);
          parts.push(
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${escapeBoundaryValue(name)}"; filename="${escapeBoundaryValue(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`
            )
          );
          parts.push(content);
          parts.push(Buffer.from('\r\n'));
        } else {
          const value = resolver.resolve(row.value).value;
          parts.push(
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${escapeBoundaryValue(name)}"\r\n\r\n${value}\r\n`
            )
          );
        }
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      const payload = Buffer.concat(parts);
      return {
        body: { data: payload, contentType: `multipart/form-data; boundary=${boundary}` },
        headers: [{ key: 'Content-Type', value: `multipart/form-data; boundary=${boundary}` }],
        contentType: 'multipart/form-data',
        summary: `Multipart form (${rows.length} fields)`,
        warnings
      };
    }
    case 'binary': {
      if (!config.binaryPath) {
        throw new HttpRequestError({ kind: 'file', message: 'No binary file selected. Choose a file in the Body tab.' });
      }
      const absolute = resolveUserPath(config.binaryPath, options.workspaceRoot);
      options.verifyFileAccess?.(absolute);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(absolute);
      } catch {
        throw new HttpRequestError({ kind: 'file', message: `The file "${config.binaryPath}" does not exist.` });
      }
      return {
        body: { data: Buffer.alloc(0), filePath: absolute, contentType: 'application/octet-stream' },
        headers: [{ key: 'Content-Type', value: 'application/octet-stream' }],
        contentType: 'application/octet-stream',
        summary: `Binary file (${stat.size} bytes)`,
        warnings
      };
    }
    default:
      return { headers: [], summary: 'No body', warnings };
  }
}

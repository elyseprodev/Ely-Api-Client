import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type { HttpErrorDetails, HttpMethod, ResponseHeader } from '../models/types';
import { isPrivateHostname } from '../utils/UrlValidator';

/**
 * Low level HTTP engine built on Node's `http`/`https` modules.
 *
 * Why not `fetch`? Node's fetch does not expose TLS options, timing information or granular abort
 * reasons, and it buffers redirects invisibly. Using the core modules gives us cancellation,
 * configurable redirects, certificate verification control, response size limits and accurate
 * timings — all of which are product requirements.
 */

export interface HttpRequestBody {
  /** Raw payload to send. */
  data: Buffer | string;
  contentType?: string;
  /** Optional file to stream instead of `data`. */
  filePath?: string;
}

export interface HttpRequestOptions {
  method: HttpMethod;
  url: string;
  headers: ResponseHeader[];
  body?: HttpRequestBody;
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  maxResponseBytes: number;
  signal?: AbortSignal;
  /** Injectable agent factory, used by tests. */
  agentFactory?: (url: URL, options: HttpRequestOptions) => http.Agent | undefined;
  allowPrivateNetwork?: boolean;
}

export interface HttpExchange {
  status: number;
  statusText: string;
  headers: ResponseHeader[];
  body: Buffer;
  finalUrl: string;
  redirects: { status: number; location: string }[];
  timings: { start: number; firstByte?: number; download?: number; total: number };
  durationMs: number;
  truncatedForLimit: boolean;
}

export class HttpRequestError extends Error {
  constructor(readonly details: HttpErrorDetails) {
    super(details.message);
    this.name = 'HttpRequestError';
  }
}

const STATUS_TEXT: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  422: 'Unprocessable Entity',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  511: 'Network Authentication Required'
};

export function statusTextFor(status: number, serverText?: string): string {
  if (serverText && serverText.trim()) {
    return serverText.trim();
  }
  return STATUS_TEXT[status] ?? '';
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Maps a Node network error to a user-facing, actionable error. */
export function classifyNetworkError(error: unknown, timeoutMs: number): HttpErrorDetails {
  const err = error as NodeJS.ErrnoException & { code?: string };
  const code = err?.code ?? '';
  const base = err?.message ?? 'Unknown network error';
  if (code === 'ABORT_ERR' || err?.name === 'AbortError' || base.includes('aborted')) {
    return { kind: 'cancelled', message: 'The request was cancelled.', code };
  }
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        kind: 'dns',
        message: `Could not resolve the host name. ${base}`,
        code,
        hint: 'Check the URL and your network/DNS settings.'
      };
    case 'ECONNREFUSED':
      return {
        kind: 'connection',
        message: 'The connection was refused by the server.',
        code,
        hint: 'Is the server running and listening on that port?'
      };
    case 'ECONNRESET':
    case 'EPIPE':
      return { kind: 'connection', message: 'The connection was reset by the server.', code };
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
      return { kind: 'timeout', message: `The request timed out after ${timeoutMs} ms.`, code, hint: 'Increase the timeout in request settings.' };
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return { kind: 'connection', message: 'The host or network is unreachable.', code };
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return {
        kind: 'tls',
        message: `TLS certificate validation failed: ${base}`,
        code,
        hint: 'Fix the certificate or, for local development only, disable TLS verification in settings.'
      };
    case 'ERR_INVALID_URL':
      return { kind: 'invalid-url', message: 'The URL is not valid.', code };
    default:
      if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) {
        return { kind: 'tls', message: `TLS error: ${base}`, code };
      }
      return { kind: 'unknown', message: base, code };
  }
}

/** Removes headers that must not be forwarded when following a cross-origin redirect. */
function stripSensitiveOnCrossOrigin(headers: ResponseHeader[], from: URL, to: URL): ResponseHeader[] {
  if (from.origin === to.origin) {
    return headers;
  }
  return headers.filter((header) => {
    const name = header.key.toLowerCase();
    return !['authorization', 'cookie', 'proxy-authorization'].includes(name);
  });
}

export class HttpClient {
  /**
   * Executes a single logical request, following redirects according to the options.
   * Rejects with an {@link HttpRequestError} carrying a structured description.
   */
  async send(options: HttpRequestOptions): Promise<HttpExchange> {
    const started = Date.now();
    const redirects: { status: number; location: string }[] = [];
    let currentUrl: URL;
    try {
      currentUrl = new URL(options.url);
    } catch {
      throw new HttpRequestError({ kind: 'invalid-url', message: 'The URL is not valid.' });
    }

    let method: HttpMethod = options.method;
    let body = options.body;
    let headers = [...options.headers];
    let attempt = 0;

    for (;;) {
      const exchange = await this.performOnce({
        ...options,
        url: currentUrl.toString(),
        method,
        headers,
        body
      });

      if (
        options.followRedirects &&
        REDIRECT_STATUSES.has(exchange.status) &&
        exchange.headers.some((h) => h.key.toLowerCase() === 'location')
      ) {
        if (attempt >= options.maxRedirects) {
          throw new HttpRequestError({
            kind: 'too-many-redirects',
            message: `Stopped after ${options.maxRedirects} redirects.`,
            hint: 'The server may be in a redirect loop. Raise the redirect limit or disable redirects.'
          });
        }
        const location = exchange.headers.find((h) => h.key.toLowerCase() === 'location')!.value;
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          throw new HttpRequestError({ kind: 'invalid-url', message: `The redirect location is invalid: ${location}` });
        }
        if (!['http:', 'https:'].includes(next.protocol)) {
          throw new HttpRequestError({
            kind: 'invalid-url',
            message: `Redirects to "${next.protocol}" are not supported.`
          });
        }
        if (options.allowPrivateNetwork === false && isPrivateHostname(next.hostname)) {
          throw new HttpRequestError({
            kind: 'blocked-address',
            message: `Redirect target "${next.hostname}" is a private address and private network access is disabled.`
          });
        }
        redirects.push({ status: exchange.status, location: next.toString() });
        if (exchange.status === 303 || ((exchange.status === 301 || exchange.status === 302) && method === 'POST')) {
          method = 'GET';
          body = undefined;
          headers = headers.filter(
            (h) => !['content-type', 'content-length', 'transfer-encoding'].includes(h.key.toLowerCase())
          );
        }
        headers = stripSensitiveOnCrossOrigin(headers, currentUrl, next);
        currentUrl = next;
        attempt++;
        continue;
      }

      return { ...exchange, redirects, durationMs: Date.now() - started };
    }
  }

  private performOnce(options: HttpRequestOptions): Promise<Omit<HttpExchange, 'redirects' | 'durationMs'>> {
    const url = new URL(options.url);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;
    const requestStarted = Date.now();

    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new HttpRequestError({ kind: 'cancelled', message: 'The request was cancelled.' }));
        return;
      }

      let settled = false;
      const finish = (fn: () => void) => {
        if (!settled) {
          settled = true;
          fn();
        }
      };

      let fileStream: fs.ReadStream | undefined;
      let payload: Buffer | string | undefined;
      if (options.body) {
        if (options.body.filePath) {
          try {
            fileStream = fs.createReadStream(options.body.filePath);
          } catch (error) {
            reject(new HttpRequestError({ kind: 'file', message: `Could not read file: ${String(error)}` }));
            return;
          }
        } else {
          payload = options.body.data;
        }
      }

      const headerRecord: Record<string, string | string[]> = {};
      for (const header of options.headers) {
        const existing = headerRecord[header.key];
        if (existing === undefined) {
          headerRecord[header.key] = header.value;
        } else if (Array.isArray(existing)) {
          existing.push(header.value);
        } else {
          headerRecord[header.key] = [existing, header.value];
        }
      }
      if (payload !== undefined && headerRecord['Content-Length'] === undefined && headerRecord['content-length'] === undefined) {
        headerRecord['Content-Length'] = String(Buffer.byteLength(payload));
      }

      const agentOptions = {
        keepAlive: false,
        rejectUnauthorized: options.verifyTls
      };

      const request = transport.request(
        {
          method: options.method,
          protocol: url.protocol,
          hostname: url.hostname.replace(/^\[|\]$/g, ''),
          port: url.port || (isHttps ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          headers: headerRecord,
          agent: options.agentFactory
            ? options.agentFactory(url, options)
            : isHttps
              ? new https.Agent(agentOptions)
              : new http.Agent({ keepAlive: false }),
          servername: isHttps ? url.hostname : undefined,
          timeout: options.timeoutMs > 0 ? options.timeoutMs : undefined
        },
        (response) => {
          const firstByte = Date.now() - requestStarted;
          const chunks: Buffer[] = [];
          let received = 0;
          let truncated = false;

          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > options.maxResponseBytes) {
              truncated = true;
              const remaining = options.maxResponseBytes - (received - chunk.length);
              if (remaining > 0) {
                chunks.push(chunk.subarray(0, remaining));
              }
              response.destroy();
              return;
            }
            chunks.push(chunk);
          });

          const complete = () => {
            const rawBody = Buffer.concat(chunks);
            const headers: ResponseHeader[] = [];
            for (let i = 0; i < response.rawHeaders.length; i += 2) {
              headers.push({ key: response.rawHeaders[i], value: response.rawHeaders[i + 1] });
            }
            const now = Date.now() - requestStarted;
            const decompressed = decompressBody(rawBody, headers).then(
              (body) => ({ body, error: undefined as undefined | string }),
              (error: Error) => ({ body: rawBody, error: error.message })
            );
            decompressed.then(({ body }) => {
              finish(() =>
                resolve({
                  status: response.statusCode ?? 0,
                  statusText: statusTextFor(response.statusCode ?? 0, response.statusMessage),
                  headers,
                  body,
                  finalUrl: url.toString(),
                  timings: { start: 0, firstByte, download: now - firstByte, total: now },
                  truncatedForLimit: truncated
                })
              );
            });
          };

          response.on('end', complete);
          response.on('close', () => {
            if (response.complete) {
              complete();
            } else if (truncated) {
              complete();
            }
          });
          response.on('error', (error) => {
            finish(() =>
              reject(new HttpRequestError(classifyNetworkError(error, options.timeoutMs)))
            );
          });
        }
      );

      if (options.timeoutMs > 0) {
        request.on('timeout', () => {
          request.destroy();
          finish(() =>
            reject(
              new HttpRequestError({
                kind: 'timeout',
                message: `The request timed out after ${options.timeoutMs} ms.`,
                code: 'ETIMEDOUT',
                hint: 'Increase the timeout in request settings or check the server.'
              })
            )
          );
        });
      }

      const onAbort = () => {
        request.destroy();
        fileStream?.destroy();
        finish(() => reject(new HttpRequestError({ kind: 'cancelled', message: 'The request was cancelled.' })));
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      request.on('error', (error) => {
        finish(() => reject(new HttpRequestError(classifyNetworkError(error, options.timeoutMs))));
      });

      request.on('close', () => {
        options.signal?.removeEventListener('abort', onAbort);
      });

      if (fileStream) {
        if (options.body?.contentType) {
          request.setHeader('Content-Type', options.body.contentType);
        }
        const stat = fs.statSync(options.body!.filePath!);
        request.setHeader('Content-Length', stat.size);
        fileStream.on('error', (error) => {
          request.destroy();
          finish(() => reject(new HttpRequestError({ kind: 'file', message: `Could not read file: ${error.message}` })));
        });
        fileStream.pipe(request);
      } else if (payload !== undefined) {
        request.end(payload);
      } else {
        request.end();
      }
    });
  }
}

/** Decompresses a gzip/deflate/br encoded body when the server ignored `Accept-Encoding: identity`. */
async function decompressBody(body: Buffer, headers: ResponseHeader[]): Promise<Buffer> {
  const encoding = headers.find((h) => h.key.toLowerCase() === 'content-encoding')?.value.trim().toLowerCase();
  if (!encoding || encoding === 'identity' || body.length === 0) {
    return body;
  }
  const run = (fn: (input: Buffer, cb: (error: Error | null, result: Buffer) => void) => void) =>
    new Promise<Buffer>((resolve, reject) => {
      fn(body, (error, result) => (error ? reject(error) : resolve(result)));
    });
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return run((input, cb) => zlib.gunzip(input, cb));
    case 'deflate':
      return run((input, cb) => zlib.inflate(input, cb));
    case 'br':
      return run((input, cb) => zlib.brotliDecompress(input, cb));
    default:
      return body;
  }
}

/** Reads a stream fully into a buffer with a hard byte limit. Exposed for tests/tools. */
export async function readStream(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) {
      chunks.push(buffer.subarray(0, buffer.length - (size - limit)));
      break;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

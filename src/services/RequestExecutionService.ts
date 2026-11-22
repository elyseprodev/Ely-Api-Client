import type {
  ApiEnvironment,
  ApiRequest,
  ApiResponse,
  HttpErrorDetails,
  KeyValueRow,
  ResponseHeader,
  SendRequestResult,
  TestRunSummary
} from '../models/types';
import { isBodylessMethod } from '../models/types';
import { buildApiResponse } from '../models/Response';
import { scopeFromEnvironment } from '../models/Environment';
import { buildUrlWithParams, validateUrl, type QueryRowInput } from '../utils/UrlValidator';
import { VariableResolver } from '../utils/VariableResolver';
import { validateHeaders } from '../security/SecurityValidator';
import { redactSecrets } from '../security/Sanitizer';
import type { AuthService } from './AuthService';
import { HttpClient, HttpRequestError, type HttpRequestBody } from './HttpClient';
import { buildRequestBody } from './RequestBodyBuilder';
import type { ScriptRunner } from '../scripting/ScriptRunner';
import type { ScriptEnvironment, ScriptRequestSnapshot, ScriptResponseSnapshot } from '../scripting/SandboxApi';

/**
 * Orchestrates a single request: variable resolution → auth → body → network → response model →
 * test scripts. Every external dependency is injectable, which keeps the pipeline testable without
 * VS Code.
 */

export interface ExecutionSettings {
  timeoutMs: number;
  followRedirects: boolean;
  maxRedirects: number;
  verifyTls: boolean;
  /** Hard limit for the received body size in bytes. */
  maxResponseBytes: number;
  /** Limit for the body sent to the UI. */
  maxDisplayBytes: number;
  allowPrivateNetwork: boolean;
  trustedHosts: string[];
  scriptTimeoutMs: number;
  scriptMemoryMb: number;
  runScripts: boolean;
}

export interface ExecutionContext {
  request: ApiRequest;
  environment?: ApiEnvironment;
  collectionVariables?: Record<string, string>;
  collectionHeaders?: KeyValueRow[];
  collectionTests?: string[];
  settings: ExecutionSettings;
  signal?: AbortSignal;
  /** File access guard (workspace trust). */
  verifyFileAccess?: (filePath: string) => void;
  /** Root used to resolve `${workspaceFolder}/…` file paths in request bodies. */
  workspaceRoot?: string | null;
}

export interface ExecutionDependencies {
  http: HttpClient;
  auth: AuthService;
  scripts?: ScriptRunner;
  /** Optional hook to persist refreshed OAuth tokens. */
  onAuthUpdated?: (request: ApiRequest, oauth: NonNullable<ApiRequest['auth']['oauth2']>) => void;
}

function emptySummary(): TestRunSummary {
  return { results: [], passed: 0, failed: 0, durationMs: 0, console: [] };
}

function messageFrom(error: unknown): HttpErrorDetails {
  if (error instanceof HttpRequestError) {
    return error.details;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'unknown', message };
}

export class RequestExecutionService {
  constructor(private readonly deps: ExecutionDependencies) {}

  /**
   * Runs the full pipeline. Never throws for expected failures (bad URL, timeout, network errors):
   * those are returned as `error` in the result so the UI can render them.
   */
  async execute(context: ExecutionContext): Promise<SendRequestResult> {
    const { request, settings } = context;
    const started = Date.now();
    const resolver = new VariableResolver(context.environment, context.collectionVariables);
    const resolvedEcho = { method: request.method, url: request.url, headers: [] as ResponseHeader[] };

    // 1. Pre-request script may set variables used by the request itself.
    let preConsole: TestRunSummary['console'] = [];
    if (settings.runScripts && this.deps.scripts && request.scripts.preRequest.trim()) {
      const pre = await this.runScripts('pre-request', request.scripts.preRequest, context, resolver, undefined);
      preConsole = pre.console;
      if (pre.error) {
        return {
          requestId: request.id,
          error: { kind: 'unknown', message: `Pre-request script failed: ${pre.error}` },
          resolved: resolvedEcho,
          durationMs: Date.now() - started
        };
      }
      resolver.setRuntimeVariables(pre.variables);
    }

    // 2. URL + parameters
    const urlResolved = resolver.resolve(request.url).value;
    const paramsResolved = resolver.resolveRows(request.params.filter((p) => p.enabled));
    let authHeaders: ResponseHeader[] = [];
    let authQueryParams: QueryRowInput[] = [];
    try {
      // Auth is applied exactly once per send: `apply()` may perform network calls (OAuth2) and
      // contributes query parameters, so calling it twice would duplicate both.
      const authApplication = await this.deps.auth.apply(request.auth, resolver);
      authHeaders = authApplication.headers;
      authQueryParams = authApplication.queryParams;
      const urlWithAuthParams = buildUrlWithParams(urlResolved, paramsResolved.rows, authQueryParams);
      const validation = validateUrl(urlWithAuthParams, {
        allowPrivateNetwork: settings.allowPrivateNetwork,
        trustedHosts: settings.trustedHosts
      });
      if (!validation.valid || !validation.url) {
        return {
          requestId: request.id,
          error: { kind: validation.code === 'blocked-host' ? 'blocked-address' : 'invalid-url', message: validation.error ?? 'Invalid URL.' },
          resolved: resolvedEcho,
          durationMs: Date.now() - started
        };
      }
    } catch (error) {
      return { requestId: request.id, error: messageFrom(error), resolved: resolvedEcho, durationMs: Date.now() - started };
    }

    const finalUrl = buildUrlWithParams(urlResolved, paramsResolved.rows, authQueryParams);
    resolvedEcho.url = finalUrl;

    // 3. Headers: collection → request → auth (auth wins so it cannot be overridden accidentally)
    const headers = new Map<string, string>();
    const headerSources: KeyValueRow[] = [...(context.collectionHeaders ?? []), ...resolver.resolveRows(request.headers).rows];
    for (const header of headerSources) {
      if (!header.enabled || !header.key.trim()) {
        continue;
      }
      const existingKey = [...headers.keys()].find((key) => key.toLowerCase() === header.key.toLowerCase());
      if (existingKey) {
        headers.set(existingKey, header.value);
      } else {
        headers.set(header.key.trim(), header.value);
      }
    }
    for (const header of authHeaders) {
      const existingKey = [...headers.keys()].find((key) => key.toLowerCase() === header.key.toLowerCase());
      if (existingKey) {
        headers.set(existingKey, header.value);
      } else {
        headers.set(header.key, header.value);
      }
    }

    // 4. Body
    let body: HttpRequestBody | undefined;
    let bodySummary = 'No body';
    try {
      const built = await buildRequestBody(request, resolver, {
        verifyFileAccess: context.verifyFileAccess,
        workspaceRoot: context.workspaceRoot
      });
      bodySummary = built.summary;
      if (built.body) {
        body = built.body;
      }
      for (const header of built.headers) {
        if (request.body.type === 'form-urlencoded' || request.body.type === 'form-data' || ![...headers.keys()].some((k) => k.toLowerCase() === header.key.toLowerCase())) {
          const existingKey = [...headers.keys()].find((key) => key.toLowerCase() === header.key.toLowerCase());
          if (existingKey) {
            headers.set(existingKey, header.value);
          } else {
            headers.set(header.key, header.value);
          }
        }
      }
    } catch (error) {
      return { requestId: request.id, error: messageFrom(error), resolved: resolvedEcho, durationMs: Date.now() - started };
    }
    if (isBodylessMethod(request.method)) {
      body = undefined;
    }

    // Common headers
    if (![...headers.keys()].some((k) => k.toLowerCase() === 'accept')) {
      headers.set('Accept', '*/*');
    }
    if (![...headers.keys()].some((k) => k.toLowerCase() === 'user-agent')) {
      headers.set('User-Agent', 'ElyApiClient/0.1 (+https://github.com/elyseprodev/Ely-Api-Client)');
    }
    if (![...headers.keys()].some((k) => k.toLowerCase() === 'accept-encoding')) {
      headers.set('Accept-Encoding', 'identity');
    }

    const finalHeaders: ResponseHeader[] = [...headers.entries()].map(([key, value]) => ({ key, value }));
    resolvedEcho.headers = finalHeaders.map((header) => ({
      key: header.key,
      value: /authorization|api-key|cookie/i.test(header.key) ? '●●●●●●' : redactSecrets(header.value)
    }));

    try {
      validateHeaders(finalHeaders.map((header) => ({ ...header, id: header.key, enabled: true, key: header.key, value: header.value })));
    } catch (error) {
      return { requestId: request.id, error: { kind: 'invalid-url', message: (error as Error).message }, resolved: resolvedEcho, durationMs: Date.now() - started };
    }

    // 5. Send
    const timeoutMs = request.settings.timeoutMs ?? settings.timeoutMs;
    let exchange;
    try {
      exchange = await this.deps.http.send({
        method: request.method,
        url: finalUrl,
        headers: finalHeaders,
        body,
        timeoutMs,
        followRedirects: request.settings.followRedirects ?? settings.followRedirects,
        maxRedirects: request.settings.maxRedirects ?? settings.maxRedirects,
        verifyTls: request.settings.verifyTls ?? settings.verifyTls,
        maxResponseBytes: settings.maxResponseBytes,
        signal: context.signal,
        allowPrivateNetwork: settings.allowPrivateNetwork
      });
    } catch (error) {
      const details = messageFrom(error);
      if (details.kind !== 'cancelled') {
        details.message = redactSecrets(details.message, resolver.secretValues);
      }
      return {
        requestId: request.id,
        error: details,
        resolved: { ...resolvedEcho, headers: withBodySummary(resolvedEcho.headers, bodySummary) },
        durationMs: Date.now() - started
      };
    }

    const response: ApiResponse = buildApiResponse({
      status: exchange.status,
      statusText: exchange.statusText,
      headers: exchange.headers,
      rawBody: exchange.body,
      durationMs: exchange.durationMs,
      timings: exchange.timings,
      finalUrl: exchange.finalUrl,
      redirects: exchange.redirects,
      maxDisplaySize: settings.maxDisplayBytes,
      requestId: request.id
    });
    if (exchange.truncatedForLimit) {
      detailsNote(response, settings.maxResponseBytes);
    }

    // 6. Test scripts (request + inherited collection tests)
    const tests = emptySummary();
    tests.console = preConsole;
    if (settings.runScripts && this.deps.scripts) {
      const scriptSources = [...(context.collectionTests ?? []), request.scripts.tests].filter((code) => code.trim());
      for (const script of scriptSources) {
        const run = await this.runScripts('tests', script, context, resolver, { request, response });
        tests.results.push(...run.results);
        tests.console.push(...run.console);
        tests.durationMs += run.durationMs;
        if (run.error) {
          tests.error = tests.error ? `${tests.error}\n${run.error}` : run.error;
        }
      }
      tests.passed = tests.results.filter((result) => result.passed).length;
      tests.failed = tests.results.filter((result) => !result.passed).length;
    }

    // Persist refreshed OAuth tokens
    if (request.auth.type === 'oauth2' && request.auth.oauth2?.accessToken) {
      this.deps.onAuthUpdated?.(request, request.auth.oauth2);
    }

    return {
      requestId: request.id,
      response,
      tests,
      resolved: { ...resolvedEcho, headers: withBodySummary(resolvedEcho.headers, bodySummary) },
      durationMs: response.durationMs
    };
  }

  private async runScripts(
    phase: 'pre-request' | 'tests',
    code: string,
    context: ExecutionContext,
    resolver: VariableResolver,
    payload: { request: ApiRequest; response: ApiResponse } | undefined
  ): Promise<{ results: TestRunSummary['results']; console: TestRunSummary['console']; variables: Record<string, string>; error?: string; durationMs: number }> {
    if (!this.deps.scripts) {
      return { results: [], console: [], variables: {}, durationMs: 0 };
    }
    const requestSnapshot: ScriptRequestSnapshot = {
      method: context.request.method,
      url: resolver.resolve(context.request.url).value,
      headers: Object.fromEntries(context.request.headers.filter((h) => h.enabled).map((h) => [h.key, resolver.resolve(h.value).value])),
      body: context.request.body.type === 'none' ? undefined : resolver.resolve(context.request.body.raw).value
    };
    const responseSnapshot: ScriptResponseSnapshot | undefined = payload
      ? {
          status: payload.response.status,
          statusText: payload.response.statusText,
          headers: Object.fromEntries(payload.response.headers.map((h) => [h.key, h.value])),
          body: payload.response.body,
          responseTime: payload.response.durationMs,
          sizeBytes: payload.response.sizeBytes,
          contentType: payload.response.contentType
        }
      : undefined;

    const envSnapshot: ScriptEnvironment = {
      request: requestSnapshot,
      response: responseSnapshot,
      variables: {},
      environment: scopeFromEnvironment(context.environment).environment ?? {},
      phase
    };

    const result = await this.deps.scripts.run({
      code,
      phase,
      environment: envSnapshot,
      timeoutMs: context.settings.scriptTimeoutMs,
      memoryLimitMb: context.settings.scriptMemoryMb
    });

    return {
      results: result.results,
      console: result.console,
      variables: result.variables,
      error: result.error,
      durationMs: result.durationMs
    };
  }
}

function withBodySummary(headers: ResponseHeader[], summary: string): ResponseHeader[] {
  return [...headers, { key: 'x-ely-body', value: summary }];
}

function detailsNote(response: ApiResponse, limit: number): void {
  response.truncated = true;
  response.headers.push({ key: 'x-ely-note', value: `body exceeded ${limit} bytes and was truncated` });
}

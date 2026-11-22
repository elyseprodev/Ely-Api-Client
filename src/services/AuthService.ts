import type { AuthConfig, HttpMethod, OAuth2Config, ResponseHeader } from '../models/types';
import { HttpClient, HttpRequestError } from './HttpClient';
import type { VariableResolver } from '../utils/VariableResolver';

/**
 * Applies authentication to outgoing requests and stores/retrieves secrets.
 *
 * Design: secrets are never kept in the document model. When the user saves a credential the
 * webview sends it to the host, which writes it to VS Code SecretStorage and stores only a
 * `secretRef` in the request. At send time this service resolves the secret from SecretStorage.
 */

export interface SecretProvider {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AuthApplication {
  headers: ResponseHeader[];
  queryParams: { key: string; value: string }[];
  /** Redacted description for the request echo (no secret values). */
  description?: string;
}

export class AuthService {
  constructor(
    private readonly secrets: SecretProvider,
    private readonly http: HttpClient
  ) {}

  static secretKeyForRequest(requestId: string): string {
    return `auth:${requestId}`;
  }

  async hasStoredSecret(ref: string | undefined): Promise<boolean> {
    if (!ref) {
      return false;
    }
    const value = await this.secrets.get(ref);
    return value !== undefined && value !== '';
  }

  /**
   * Resolves the effective auth config: if a `secretRef` is present, the stored value replaces the
   * placeholder token / password / key value.
   */
  async resolveAuth(auth: AuthConfig, resolver?: VariableResolver): Promise<AuthConfig> {
    const resolved: AuthConfig = { ...auth };
    if (auth.oauth2) {
      resolved.oauth2 = { ...auth.oauth2, grantType: auth.oauth2.grantType ?? 'client-credentials', tokenUrl: auth.oauth2.tokenUrl ?? '', clientId: auth.oauth2.clientId ?? '', clientAuth: auth.oauth2.clientAuth ?? 'header' };
    }
    if (auth.secretRef) {
      const secret = await this.secrets.get(auth.secretRef);
      if (secret !== undefined) {
        if (auth.type === 'basic') {
          const separator = secret.indexOf(':');
          resolved.username = separator === -1 ? secret : secret.slice(0, separator);
          resolved.password = separator === -1 ? '' : secret.slice(separator + 1);
        } else if (auth.type === 'api-key') {
          resolved.keyValue = secret;
        } else {
          resolved.token = secret;
        }
      }
    }
    if (auth.type === 'oauth2' && auth.oauth2?.clientSecret && auth.secretRef) {
      const secret = await this.secrets.get(auth.secretRef);
      if (secret) {
        if (resolved.oauth2) {
          resolved.oauth2.clientSecret = secret;
        }
      }
    }
    if (resolver) {
      if (resolved.token) {
        resolved.token = resolver.resolve(resolved.token).value;
      }
      if (resolved.username) {
        resolved.username = resolver.resolve(resolved.username).value;
      }
      if (resolved.password) {
        resolved.password = resolver.resolve(resolved.password).value;
      }
      if (resolved.keyName) {
        resolved.keyName = resolver.resolve(resolved.keyName).value;
      }
      if (resolved.keyValue) {
        resolved.keyValue = resolver.resolve(resolved.keyValue).value;
      }
      if (resolved.oauth2 && auth.oauth2) {
        resolved.oauth2 = {
          ...resolved.oauth2,
          grantType: resolved.oauth2.grantType ?? 'client-credentials',
          tokenUrl: resolver.resolve(resolved.oauth2.tokenUrl ?? '').value,
          clientId: resolver.resolve(resolved.oauth2.clientId ?? '').value,
          clientSecret: resolver.resolve(resolved.oauth2.clientSecret ?? '').value,
          scope: resolver.resolve(resolved.oauth2.scope ?? '').value,
          username: resolver.resolve(resolved.oauth2.username ?? '').value,
          password: resolver.resolve(resolved.oauth2.password ?? '').value
        };
      }
    }
    return resolved;
  }

  /**
   * Computes headers and query parameters for an auth config. Never mutates the input.
   */
  async apply(auth: AuthConfig, resolver?: VariableResolver): Promise<AuthApplication> {
    const headers: ResponseHeader[] = [];
    const queryParams: { key: string; value: string }[] = [];
    if (!auth || auth.type === 'none') {
      return { headers, queryParams };
    }
    const resolved = await this.resolveAuth(auth, resolver);
    switch (resolved.type) {
      case 'bearer': {
        if (resolved.token) {
          const prefix = resolved.prefix === undefined ? 'Bearer ' : resolved.prefix;
          headers.push({ key: 'Authorization', value: `${prefix}${resolved.token}` });
        }
        return { headers, queryParams, description: 'Bearer token' };
      }
      case 'basic': {
        const username = resolved.username ?? '';
        const password = resolved.password ?? '';
        const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
        headers.push({ key: 'Authorization', value: `Basic ${encoded}` });
        return { headers, queryParams, description: `Basic auth (${username})` };
      }
      case 'api-key': {
        const name = resolved.keyName || 'X-API-Key';
        if (resolved.keyLocation === 'query') {
          queryParams.push({ key: name, value: resolved.keyValue ?? '' });
          return { headers, queryParams, description: `API key in query (${name})` };
        }
        headers.push({ key: name, value: resolved.keyValue ?? '' });
        return { headers, queryParams, description: `API key in header (${name})` };
      }
      case 'oauth2': {
        const token = await this.getOAuth2Token(resolved.oauth2);
        if (token) {
          headers.push({ key: 'Authorization', value: `Bearer ${token}` });
        }
        return { headers, queryParams, description: `OAuth 2.0 (${resolved.oauth2?.grantType})` };
      }
      default:
        return { headers, queryParams };
    }
  }

  /**
   * Requests an access token using the configured grant. Returns `undefined` when configuration is
   * incomplete (caller will surface a warning). Tokens are cached on the auth config by the caller.
   */
  async getOAuth2Token(config: OAuth2Config | undefined, forceRefresh = false): Promise<string | undefined> {
    if (!config) {
      return undefined;
    }
    const now = Date.now();
    if (!forceRefresh && config.accessToken && config.tokenExpiresAt && config.tokenExpiresAt > now + 5000) {
      return config.accessToken;
    }
    if (!config.tokenUrl) {
      throw new HttpRequestError({
        kind: 'invalid-url',
        message: 'OAuth 2.0 token URL is not configured.',
        hint: 'Open the Authorization tab and fill in the token URL.'
      });
    }
    if (config.grantType === 'authorization-code') {
      throw new HttpRequestError({
        kind: 'unknown',
        message: 'The authorization code grant requires an interactive browser flow which is not supported yet.',
        hint: 'Use the client credentials grant, or paste an access token using Bearer auth.'
      });
    }

    const params = new URLSearchParams();
    params.set('grant_type', config.grantType === 'password' ? 'password' : 'client_credentials');
    if (config.scope) {
      params.set('scope', config.scope);
    }
    if (config.grantType === 'password') {
      params.set('username', config.username ?? '');
      params.set('password', config.password ?? '');
    }
    const headers: ResponseHeader[] = [
      { key: 'Content-Type', value: 'application/x-www-form-urlencoded' },
      { key: 'Accept', value: 'application/json' }
    ];
    if (config.clientAuth === 'body') {
      params.set('client_id', config.clientId);
      params.set('client_secret', config.clientSecret ?? '');
    } else {
      headers.push({
        key: 'Authorization',
        value: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret ?? ''}`, 'utf8').toString('base64')}`
      });
    }

    const exchange = await this.http.send({
      method: 'POST' as HttpMethod,
      url: config.tokenUrl,
      headers,
      body: { data: params.toString(), contentType: 'application/x-www-form-urlencoded' },
      timeoutMs: 30000,
      followRedirects: true,
      maxRedirects: 3,
      verifyTls: true,
      maxResponseBytes: 1024 * 1024
    });

    const text = exchange.body.toString('utf8');
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new HttpRequestError({
        kind: 'unknown',
        message: `The OAuth token endpoint returned a non-JSON response (HTTP ${exchange.status}).`
      });
    }
    if (exchange.status < 200 || exchange.status >= 300) {
      const errorDescription =
        (payload.error_description as string | undefined) ?? (payload.error as string | undefined) ?? `HTTP ${exchange.status}`;
      throw new HttpRequestError({ kind: 'unknown', message: `OAuth token request failed: ${errorDescription}` });
    }
    const accessToken = payload.access_token as string | undefined;
    if (!accessToken) {
      throw new HttpRequestError({ kind: 'unknown', message: 'The OAuth token endpoint did not return an access_token.' });
    }
    const expiresIn = Number(payload.expires_in);
    config.accessToken = accessToken;
    if (typeof payload.refresh_token === 'string') {
      config.refreshToken = payload.refresh_token;
    }
    config.tokenExpiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : now + 3600_000;
    return accessToken;
  }

  /**
   * Persists the credential of an auth config to SecretStorage and returns the sanitised config with
   * a `secretRef` and empty credential fields.
   */
  async persistSecret(requestId: string, auth: AuthConfig): Promise<AuthConfig> {
    const ref = AuthService.secretKeyForRequest(requestId);
    const sanitized: AuthConfig = { ...auth, secretRef: ref };
    // The webview masks stored credentials with a placeholder; never overwrite the real secret
    // with it when the user saves without editing the field.
    const isPlaceholder = (value: string | undefined) => value === undefined || value === '' || /^[•●*]+$/.test(value);
    if (auth.secretRef && isPlaceholder(auth.token) && isPlaceholder(auth.password) && isPlaceholder(auth.keyValue) && isPlaceholder(auth.oauth2?.clientSecret)) {
      const existing = await this.secrets.get(ref);
      const sanitizedExisting: AuthConfig = { ...auth, secretRef: existing ? ref : undefined };
      if (auth.type === 'basic') {
        sanitizedExisting.password = '';
      } else if (auth.type === 'api-key') {
        sanitizedExisting.keyValue = '';
      } else if (auth.type === 'oauth2') {
        sanitizedExisting.oauth2 = auth.oauth2
          ? { ...auth.oauth2, clientSecret: '', accessToken: undefined, refreshToken: undefined }
          : undefined;
      } else {
        sanitizedExisting.token = '';
      }
      return sanitizedExisting;
    }
    let secret: string | undefined;
    if (auth.type === 'basic') {
      secret = `${auth.username ?? ''}:${auth.password ?? ''}`;
      sanitized.username = auth.username ?? '';
      sanitized.password = '';
    } else if (auth.type === 'api-key') {
      secret = auth.keyValue ?? '';
      sanitized.keyValue = '';
    } else if (auth.type === 'oauth2') {
      secret = auth.oauth2?.clientSecret ?? '';
      if (auth.oauth2) {
        sanitized.oauth2 = { ...auth.oauth2, clientSecret: '', accessToken: undefined, refreshToken: undefined };
      }
    } else if (auth.type === 'bearer') {
      secret = auth.token ?? '';
      sanitized.token = '';
    }

    if (secret) {
      await this.secrets.store(ref, secret);
      return sanitized;
    }
    await this.secrets.delete(ref);
    return { ...sanitized, secretRef: undefined };
  }
}

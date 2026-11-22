import { describe, it, expect } from 'vitest';
import { redactSecrets, escapeHtml, isSensitiveHeader, maskHeaderValue } from '../../src/security/Sanitizer';
import { validateHeaders } from '../../src/security/SecurityValidator';
import { VariableResolver } from '../../src/utils/VariableResolver';

describe('redactSecrets', () => {
  it('masks bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abc123def456')).not.toContain('abc123def456');
  });

  it('masks api keys in query strings', () => {
    expect(redactSecrets('https://x.dev/a?api_key=secretvalue')).not.toContain('secretvalue');
  });

  it('leaves ordinary text alone', () => {
    expect(redactSecrets('GET https://x.dev/health returned 200')).toBe('GET https://x.dev/health returned 200');
  });
});

describe('escapeHtml', () => {
  it('escapes markup from API responses', () => {
    const out = escapeHtml('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;');
  });
});

describe('header masking', () => {
  it('identifies sensitive headers', () => {
    expect(isSensitiveHeader('Authorization')).toBe(true);
    expect(isSensitiveHeader('Cookie')).toBe(true);
    expect(isSensitiveHeader('Content-Type')).toBe(false);
  });

  it('masks the credential but keeps the auth scheme readable', () => {
    const masked = maskHeaderValue('Bearer xyz');
    expect(masked).not.toContain('xyz');
    expect(masked).toContain('Bearer');
    // Callers only apply this to headers flagged by `isSensitiveHeader`.
    expect(isSensitiveHeader('Content-Type')).toBe(false);
  });

  it('never leaks a short token suffix', () => {
    expect(maskHeaderValue('abc12345')).toBe('●●●●●●');
    expect(maskHeaderValue('Basic dXNlcjpwYXNz')).not.toContain('wYXNz');
  });
});

describe('validateHeaders', () => {
  const row = (key: string, value: string) => ({ id: key, key, value, enabled: true, description: '' });

  it('accepts normal headers', () => {
    expect(() => validateHeaders([row('Accept', 'application/json')])).not.toThrow();
  });

  it('rejects header injection through values', () => {
    expect(() => validateHeaders([row('X-Test', 'a\r\nX-Injected: 1')])).toThrow();
  });

  it('rejects invalid header names', () => {
    expect(() => validateHeaders([row('Bad Header', 'x')])).toThrow();
  });
});

describe('VariableResolver', () => {
  const env = (key: string, value: string, secret = false) => ({
    id: 'env-1',
    name: 'Local',
    variables: [{ id: '1', key, value, enabled: true, secret, description: '' }],
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z'
  });

  it('resolves environment variables', () => {
    const resolver = new VariableResolver(env('host', 'env.dev'));
    expect(resolver.resolve('https://{{host}}/x').value).toBe('https://env.dev/x');
  });

  it('gives the active environment precedence over collection variables', () => {
    const resolver = new VariableResolver(env('host', 'env.dev'), { host: 'coll.dev' });
    expect(resolver.resolve('https://{{host}}/x').value).toBe('https://env.dev/x');
  });

  it('falls back to collection variables when the environment is silent', () => {
    const resolver = new VariableResolver(env('other', 'x'), { host: 'coll.dev' });
    expect(resolver.resolve('https://{{host}}/x').value).toBe('https://coll.dev/x');
  });

  it('reports unresolved variables', () => {
    const resolver = new VariableResolver();
    expect(resolver.resolve('{{missing}}').unresolved).toContain('missing');
  });

  it('tracks secret values so they can be redacted from output', () => {
    const resolver = new VariableResolver(env('token', 'super-secret', true));
    expect(resolver.resolve('Bearer {{token}}').value).toBe('Bearer super-secret');
    expect(resolver.secretValues).toContain('super-secret');
    expect(redactSecrets('failed with super-secret', resolver.secretValues)).not.toContain('super-secret');
  });
});

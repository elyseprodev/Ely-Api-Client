import { describe, it, expect } from 'vitest';
import { validateUrl, buildUrlWithParams, displayUrl } from '../../src/utils/UrlValidator';

describe('validateUrl', () => {
  it('accepts http and https', () => {
    expect(validateUrl('https://api.example.com/v1').valid).toBe(true);
    expect(validateUrl('http://localhost:8080/x').valid).toBe(true);
  });

  it('rejects unsupported protocols', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,x']) {
      const result = validateUrl(url);
      expect(result.valid, url).toBe(false);
      expect(result.code, url).toBe('protocol');
    }
  });

  it('rejects malformed urls', () => {
    expect(validateUrl('not a url').valid).toBe(false);
    expect(validateUrl('').valid).toBe(false);
  });

  it('blocks private networks when disabled', () => {
    const options = { allowPrivateNetwork: false, trustedHosts: [] };
    for (const url of ['http://127.0.0.1/x', 'http://localhost/x', 'http://10.0.0.5/x', 'http://192.168.1.2/x', 'http://169.254.169.254/latest']) {
      const result = validateUrl(url, options);
      expect(result.valid, url).toBe(false);
      expect(result.code, url).toBe('blocked-host');
    }
    expect(validateUrl('http://8.8.8.8/x', options).valid).toBe(true);
  });

  it('honours trusted hosts when private networks are disabled', () => {
    const result = validateUrl('http://localhost:8080/x', { allowPrivateNetwork: false, trustedHosts: ['localhost:8080'] });
    expect(result.valid).toBe(true);
  });

  it('blocks non-http schemes in trusted input too', () => {
    expect(validateUrl('gopher://example.com', { allowPrivateNetwork: true, trustedHosts: ['example.com'] }).valid).toBe(false);
  });
});

describe('buildUrlWithParams', () => {
  const row = (key: string, value: string, enabled = true) => ({ id: key, key, value, enabled, description: '' });

  it('appends enabled rows', () => {
    expect(buildUrlWithParams('https://x.dev/a', [row('page', '2'), row('q', 'hi')])).toBe('https://x.dev/a?page=2&q=hi');
  });

  it('skips disabled rows and removes their keys from the base url', () => {
    expect(buildUrlWithParams('https://x.dev/a?page=1&limit=2', [row('limit', '2', false)])).toBe('https://x.dev/a?page=1');
  });

  it('overrides existing query parameters', () => {
    expect(buildUrlWithParams('https://x.dev/a?page=1', [row('page', '5')])).toBe('https://x.dev/a?page=5');
  });

  it('preserves the hash fragment', () => {
    expect(buildUrlWithParams('https://x.dev/a#top', [row('page', '2')])).toBe('https://x.dev/a?page=2#top');
  });

  it('encodes keys and values', () => {
    expect(buildUrlWithParams('https://x.dev/a', [row('q', 'a b&c')])).toBe('https://x.dev/a?q=a%20b%26c');
  });

  it('merges extra auth params without duplicating keys', () => {
    expect(buildUrlWithParams('https://x.dev/a', [row('page', '1')], [{ key: 'access_token', value: 't' }])).toBe(
      'https://x.dev/a?page=1&access_token=t'
    );
  });

  it('returns the input for empty urls', () => {
    expect(buildUrlWithParams('  ', [])).toBe('');
  });
});

describe('displayUrl', () => {
  it('redacts credentials', () => {
    expect(displayUrl('https://user:pass@example.com/x')).not.toContain('pass');
  });

  it('keeps plain urls intact', () => {
    expect(displayUrl('https://example.com/a?b=1')).toContain('example.com/a');
  });
});

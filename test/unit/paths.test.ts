import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { expandPortablePath, resolveUserPath, toPortablePath, WORSPACE_ROOT_PLACEHOLDER } from '../../src/utils/paths';
import { buildRequestBody } from '../../src/services/RequestBodyBuilder';
import { VariableResolver } from '../../src/utils/VariableResolver';
import { createRequest } from '../../src/models/Request';

const ROOT = path.sep === '/' ? '/work/project' : 'C:\\work\\project';

describe('portable request-body paths', () => {
  it('round-trips a workspace-relative path', () => {
    const portable = toPortablePath(path.join(ROOT, 'fixtures', 'payment.json'), ROOT);
    expect(portable).toBe(`${WORSPACE_ROOT_PLACEHOLDER}/fixtures/payment.json`);
    expect(expandPortablePath(portable, ROOT)).toBe(path.join(ROOT, 'fixtures', 'payment.json'));
  });

  it('resolves a ${workspaceFolder} path even when it is the only root available', () => {
    // Regression: binary bodies used to pass the literal placeholder as the root, so the file
    // lookup became `<cwd>/${workspaceFolder}/fixtures/...`.
    const resolved = resolveUserPath(`${WORSPACE_ROOT_PLACEHOLDER}/fixtures/payment.json`, WORSPACE_ROOT_PLACEHOLDER);
    expect(resolved).not.toContain(WORSPACE_ROOT_PLACEHOLDER);
    expect(resolved).toBe(path.resolve('fixtures', 'payment.json'));
  });

  it('expands a ${workspaceFolder} path against a real workspace root', () => {
    const resolved = resolveUserPath(`${WORSPACE_ROOT_PLACEHOLDER}/fixtures/payment.json`, ROOT);
    expect(resolved).toBe(path.join(ROOT, 'fixtures', 'payment.json'));
  });

  it('leaves absolute paths untouched', () => {
    const absolute = path.join(ROOT, 'a', 'b.json');
    expect(resolveUserPath(absolute, ROOT)).toBe(absolute);
  });
});

describe('buildRequestBody file fields', () => {
  const resolver = new VariableResolver();

  it('reports a missing multipart file with the expanded path, not the raw placeholder', async () => {
    const request = createRequest({ method: 'POST', url: 'http://127.0.0.1:1/upload' });
    request.body = {
      type: 'form-data',
      raw: '',
      form: [
        {
          id: 'row-1',
          enabled: true,
          key: 'payload',
          value: '',
          type: 'file',
          filePath: `${WORSPACE_ROOT_PLACEHOLDER}/fixtures/does-not-exist.json`
        }
      ]
    };

    await expect(
      buildRequestBody(request, resolver, { workspaceRoot: ROOT })
    ).rejects.toThrow(/does-not-exist\.json/);
  });

  it('requires a binary file to be selected instead of silently sending an empty body', async () => {
    const request = createRequest({ method: 'POST', url: 'http://127.0.0.1:1/upload' });
    request.body = { type: 'binary', raw: '', form: [], binaryPath: '' };
    await expect(buildRequestBody(request, resolver, { workspaceRoot: ROOT })).rejects.toThrow(/No binary file/);
  });
});

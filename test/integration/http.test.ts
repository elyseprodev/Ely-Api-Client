import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockApi, type MockApi } from '../../src/testing/mockApiServer';
import { createTestClient, type TestClient } from '../helpers/harness';
import { createRequest } from '../../src/models/Request';
import type { ApiRequest } from '../../src/models/types';

let api: MockApi;
let client: TestClient;

beforeAll(async () => {
  api = await startMockApi();
  client = createTestClient({ allowPrivateNetwork: true });
});
afterAll(async () => {
  client?.dispose();
  await api.close();
});

async function send(request: ApiRequest) {
  const finishedPromise = client.waitFor('request:finished', (message) => message.requestId === request.id);
  await client.send({ type: 'request:send', requestId: request.id, payload: { request } });
  const message = await finishedPromise;
  return message.payload as {
    response?: import('../../src/models/types').ApiResponse;
    error?: { kind: string; message: string };
    tests?: { results: { name: string; passed: boolean; error?: string }[] };
  };
}

describe('HTTP execution', () => {
  it('performs GET and returns parsed body, headers and timing', async () => {
    const request = createRequest({ url: `${api.url}/api/v1/products`, name: 'list' });
    const result = await send(request);
    expect(result.error).toBeUndefined();
    expect(result.response?.status).toBe(200);
    expect(result.response?.statusText).toBe('OK');
    expect(result.response?.headers.some((header) => header.key.toLowerCase() === 'content-type')).toBe(true);
    expect(result.response?.body).toContain('"items"');
    expect(result.response?.timings.total).toBeGreaterThanOrEqual(0);
  });

  it('performs POST with a JSON body and returns 201', async () => {
    const request = createRequest({ url: `${api.url}/api/v1/products`, method: 'POST', name: 'create' });
    request.body = { type: 'json', raw: '{"name":"Widget","price":9}', form: [] };
    const result = await send(request);
    expect(result.response?.status).toBe(201);
    expect(result.response?.body).toContain('created');
    expect(api.requests.at(-1)?.method).toBe('POST');
    expect(api.requests.at(-1)?.body).toContain('Widget');
  });

  it('sends query parameters and headers', async () => {
    const request = createRequest({ url: `${api.url}/api/v1/products` });
    request.params = [{ id: 'p1', key: 'page', value: '2', enabled: true, description: '' }];
    request.headers = [{ id: 'h1', key: 'x-ely-test', value: 'yes', enabled: true, description: '' }];
    await send(request);
    const seen = api.requests.at(-1);
    expect(seen?.url).toContain('page=2');
    expect(seen?.headers['x-ely-test']).toBe('yes');
  });

  it('resolves environment variables in URL and headers', async () => {
    const environment = client.core.environments.create('E2E');
    await client.core.environments.saveVariables(environment.id, [
      { id: 'v1', key: 'baseUrl', value: api.url, enabled: true, secret: false }
    ]);
    client.core.environments.setActive(environment.id);
    const request = createRequest({ url: '{{baseUrl}}/api/v1/products' });
    const result = (await send(request)) as { response?: { status: number }; resolved?: { url: string } };
    expect(result.response?.status).toBe(200);
    expect(result.resolved?.url).toContain(api.url);
  });

  it('reports blocked private addresses when the setting is off', async () => {
    const blocked = createTestClient({ allowPrivateNetwork: false });
    try {
      const request = createRequest({ url: `${api.url}/api/v1/products` });
      const finished = blocked.waitFor('request:finished', (message) => message.requestId === request.id);
      await blocked.send({ type: 'request:send', requestId: request.id, payload: { request } });
      const result = (await finished).payload as { error?: { kind: string; message: string } };
      expect(result.error?.kind).toBe('blocked-address');
    } finally {
      blocked.dispose();
    }
  });

  it('surfaces HTTP error statuses without throwing', async () => {
    const request = createRequest({ url: `${api.url}/error/500` });
    const result = await send(request);
    expect(result.response?.status).toBe(500);
    expect(result.error).toBeUndefined();
  });

  it('runs collection tests and reports failures', async () => {
    const request = createRequest({ url: `${api.url}/api/v1/products` });
    request.scripts = {
      preRequest: '',
      tests: 'pm.test("status is 200", () => pm.expect(pm.response.code).to.equal(200));\npm.test("always fails", () => pm.expect(1).to.equal(2));'
    };
    const result = await send(request);
    expect(result.tests?.results.filter((test) => test.passed)).toHaveLength(1);
    expect(result.tests?.results.filter((test) => !test.passed)).toHaveLength(1);
    expect(result.tests?.results.find((test) => !test.passed)?.error).toContain('expected 1 to equal 2');
  });

  it('decompresses gzip responses', async () => {
    const request = createRequest({ url: `${api.url}/gzip` });
    const result = await send(request);
    expect(result.response?.body).toContain('compressed');
  });

  it('follows redirect chains when configured', async () => {
    const request = createRequest({ url: `${api.url}/redirect-chain?n=2` });
    const result = await send(request);
    expect(result.response?.status).toBe(200);
    expect(result.response?.redirects.length).toBeGreaterThanOrEqual(2);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockApi, type MockApi } from '../../src/testing/mockApiServer';
import { createTestClient, type TestClient } from '../helpers/harness';
import { createRequest } from '../../src/models/Request';

let api: MockApi;
let client: TestClient;

beforeAll(async () => {
  api = await startMockApi();
  client = createTestClient();
});
afterAll(async () => {
  client?.dispose();
  await api.close();
});

async function send(request: ReturnType<typeof createRequest>) {
  const finished = client.waitFor('request:finished', (message) => message.requestId === request.id);
  await client.send({ type: 'request:send', requestId: request.id, payload: { request } });
  return (await finished).payload as {
    response?: { status: number; body: string };
    error?: { kind: string; message: string };
  };
}

describe('authorization', () => {
  it('sends a bearer token header', async () => {
    const request = createRequest({ url: `${api.url}/echo` });
    request.auth = { type: 'bearer', token: 'secret-token-value' };
    const result = await send(request);
    expect(result.error).toBeUndefined();
    const echoed = JSON.parse(result.response!.body);
    expect(echoed.headers.authorization).toContain('Bearer');
    expect(echoed.headers.authorization).toContain('secret-token');
  });

  it('sends basic auth as base64 credentials', async () => {
    const request = createRequest({ url: `${api.url}/echo` });
    request.auth = { type: 'basic', username: 'user', password: 'pass' };
    const result = await send(request);
    const echoed = JSON.parse(result.response!.body);
    expect(echoed.headers.authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  it('sends an api key in a header', async () => {
    const request = createRequest({ url: `${api.url}/echo` });
    request.auth = { type: 'api-key', keyName: 'x-api-key', keyValue: 'abc123', keyLocation: 'header' };
    const result = await send(request);
    const echoed = JSON.parse(result.response!.body);
    expect(echoed.headers['x-api-key']).toBe('abc123');
  });

  it('sends an api key as a query parameter', async () => {
    const request = createRequest({ url: `${api.url}/echo` });
    request.auth = { type: 'api-key', keyName: 'api_key', keyValue: 'abc123', keyLocation: 'query' };
    const result = await send(request);
    const echoed = JSON.parse(result.response!.body);
    expect(echoed.query.api_key).toBe('abc123');
  });

  it('exchanges OAuth2 client credentials for a token exactly once', async () => {
    const request = createRequest({ url: `${api.url}/echo` });
    request.auth = {
      type: 'oauth2',
      oauth2: {
        grantType: 'client-credentials',
        tokenUrl: `${api.url}/oauth/token`,
        clientId: 'ely-client',
        clientSecret: 'ely-secret',
        scope: 'read',
        clientAuth: 'header'
      }
    };
    const result = await send(request);
    expect(result.error).toBeUndefined();
    const tokenCalls = api.requests.filter((seen) => seen.url.includes('/oauth/token'));
    expect(tokenCalls).toHaveLength(1);
    const echoed = JSON.parse(result.response!.body);
    expect(echoed.headers.authorization).toMatch(/^Bearer /);
  });

  it('reports a failed token exchange instead of sending an unauthenticated request', async () => {
    const request = createRequest({ url: `${api.url}/echo` });
    request.auth = {
      type: 'oauth2',
      oauth2: {
        grantType: 'client-credentials',
        tokenUrl: `${api.url}/error/500`,
        clientId: 'x',
        clientSecret: 'y',
        scope: '',
        clientAuth: 'header'
      }
    };
    const result = await send(request);
    expect(result.error).toBeDefined();
  });
});

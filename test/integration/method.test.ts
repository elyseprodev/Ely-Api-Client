import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockApi, type MockApi } from '../../src/testing/mockApiServer';
import { createTestClient } from '../helpers/harness';
import { createRequest } from '../../src/models/Request';

let api: MockApi;
beforeAll(async () => { api = await startMockApi(); });
afterAll(async () => { await api.close(); });

describe('method handling', () => {
  it('posts and gets 201', async () => {
    const client = createTestClient();
    const request = createRequest({ url: `${api.url}/api/v1/products`, method: 'POST', name: 'create' });
    request.body = { type: 'json', raw: '{"name":"Widget"}', form: [] };
    await client.send({ type: 'request:send', requestId: request.id, payload: { request } });
    const finished = await client.waitFor('request:finished');
    const result = finished.payload as any;
    console.log('method seen by api:', api.requests.map(r => `${r.method} ${r.url}`));
    console.log('status:', result.response?.status, 'err:', JSON.stringify(result.error));
    expect(result.response?.status).toBe(201);
  });
});

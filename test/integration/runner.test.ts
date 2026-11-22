import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockApi, type MockApi } from '../../src/testing/mockApiServer';
import { createTestClient, type TestClient } from '../helpers/harness';
import { createRequest } from '../../src/models/Request';
import type { ApiRequest, RunSummary } from '../../src/models/types';

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

/** Creates a collection and stores requests inside it, returning the collection id. */
function seedCollection(name: string, requests: ApiRequest[]): string {
  const collection = client.core['collections'].createCollection(name);
  for (const request of requests) {
    client.core['collections'].saveRequest({ ...request, collectionId: collection.id });
  }
  return collection.id;
}

function folder(collectionId: string, name: string, parentFolderId: string | null = null) {
  const created = client.core['collections'].createFolder(collectionId, name, parentFolderId);
  if (!created) {
    throw new Error(`Could not create folder ${name}`);
  }
  return created;
}

/**
 * Waits for a message that arrives *after* this call starts. `TestClient.waitFor` replays the first
 * historical match, which would hand every test the first run's result.
 */
function waitForNew(type: string): Promise<Record<string, unknown>> {
  const seen = client.messages.filter((message) => message.type === type).length;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const matches = client.messages.filter((message) => message.type === type);
      if (matches.length > seen) {
        resolve(matches[seen]);
        return;
      }
      if (Date.now() - started > 8000) {
        reject(new Error(`Timed out waiting for a new ${type}`));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function run(payload: Record<string, unknown>): Promise<{ run?: RunSummary; error?: { message: string } }> {
  const finished = waitForNew('run:finished');
  await client.send({ type: 'run:start', payload });
  return (await finished).payload as { run?: RunSummary; error?: { message: string } };
}

describe('collection runner', () => {
  it('runs every request in a collection and aggregates the test results', async () => {
    const collectionId = seedCollection('Runner — aggregate', [
      createRequest({ url: `${api.url}/api/v1/products`, name: 'List products' }),
      createRequest({ url: `${api.url}/api/v1/orders`, name: 'List orders' })
    ]);

    const { run: summary } = await run({ collectionId });
    expect(summary).toBeDefined();
    expect(summary!.status).toBe('passed');
    expect(summary!.totalRequests).toBe(2);
    expect(summary!.passedRequests).toBe(2);
    expect(summary!.failedRequests).toBe(0);
    expect(summary!.items.map((item) => item.name)).toEqual(['List products', 'List orders']);
    expect(summary!.items.every((item) => item.status === 200)).toBe(true);
    expect(summary!.durationMs).toBeGreaterThanOrEqual(0);
    expect(summary!.finishedAt).toBeGreaterThanOrEqual(summary!.startedAt);
  });

  it('counts assertions across the whole run', async () => {
    const passing = createRequest({ url: `${api.url}/api/v1/products`, name: 'Asserts pass' });
    passing.scripts.tests = 'pm.test("status is 200", () => pm.response.to.have.status(200));\n' +
      'pm.test("has a body", () => pm.expect(pm.response.text().length).to.be.greaterThan(0));';
    const collectionId = seedCollection('Runner — assertions', [passing]);

    const { run: summary } = await run({ collectionId });
    expect(summary!.passedTests).toBe(2);
    expect(summary!.failedTests).toBe(0);
    expect(summary!.totalTests).toBe(2);
    expect(summary!.items[0].tests?.results).toHaveLength(2);
  });

  it('marks the run failed when an assertion fails, without stopping later requests', async () => {
    const failing = createRequest({ url: `${api.url}/api/v1/products`, name: 'Asserts fail' });
    failing.scripts.tests = 'pm.test("expects 500", () => pm.response.to.have.status(500));';
    const passing = createRequest({ url: `${api.url}/api/v1/orders`, name: 'Still runs' });
    const collectionId = seedCollection('Runner — failure', [failing, passing]);

    const { run: summary } = await run({ collectionId });
    expect(summary!.status).toBe('failed');
    expect(summary!.failedRequests).toBe(1);
    expect(summary!.passedRequests).toBe(1);
    expect(summary!.failedTests).toBe(1);
    expect(summary!.items).toHaveLength(2);
    expect(summary!.items[1].status).toBe(200);
  });

  it('records an unreachable host as an errored request and keeps going', async () => {
    const broken = createRequest({ url: 'http://127.0.0.1:1/nope', name: 'Dead host' });
    const working = createRequest({ url: `${api.url}/api/v1/products`, name: 'Healthy' });
    const collectionId = seedCollection('Runner — errors', [broken, working]);

    const { run: summary } = await run({ collectionId });
    expect(summary!.erroredRequests).toBe(1);
    expect(summary!.items[0].error).toBeDefined();
    expect(summary!.items[1].status).toBe(200);
    expect(summary!.status).toBe('failed');
  });

  it('scopes a run to a folder and its subfolders only', async () => {
    const collection = client.core['collections'].createCollection('Runner — folders');
    const outer = folder(collection.id, 'Payments');
    const inner = folder(collection.id, 'Refunds', outer.id);
    const root = createRequest({ url: `${api.url}/echo`, name: 'Root request' });
    const inOuter = createRequest({ url: `${api.url}/echo`, name: 'Outer request' });
    const inInner = createRequest({ url: `${api.url}/echo`, name: 'Inner request' });
    client.core['collections'].saveRequest({ ...root, collectionId: collection.id });
    client.core['collections'].saveRequest({ ...inOuter, collectionId: collection.id, folderId: outer.id });
    client.core['collections'].saveRequest({ ...inInner, collectionId: collection.id, folderId: inner.id });

    const { run: summary } = await run({ collectionId: collection.id, folderId: outer.id });
    expect(summary!.totalRequests).toBe(2);
    expect(summary!.items.map((item) => item.name)).toEqual(['Outer request', 'Inner request']);
    expect(summary!.folderName).toBe('Payments');
  });

  it('reports progress while the run is in flight', async () => {
    const collectionId = seedCollection('Runner — progress', [
      createRequest({ url: `${api.url}/echo`, name: 'One' }),
      createRequest({ url: `${api.url}/echo`, name: 'Two' })
    ]);

    const seenProgress = client.messages.filter((message) => message.type === 'run:progress').length;
    const finished = waitForNew('run:finished');
    await client.send({ type: 'run:start', payload: { collectionId } });
    await finished;

    const progress = client.messages
      .filter((message) => message.type === 'run:progress')
      .slice(seenProgress)
      .map((message) => (message.payload as { run: RunSummary }).run);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].status).toBe('running');
    // Progress is monotonic: the completed item count never decreases.
    const counts = progress.map((summary) => summary.items.length);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(progress.at(-1)!.status).not.toBe('running');
  });

  it('records each request of a batch run in history', async () => {
    const collectionId = seedCollection('Runner — history', [
      createRequest({ url: `${api.url}/api/v1/products`, name: 'History A' }),
      createRequest({ url: `${api.url}/api/v1/orders`, name: 'History B' })
    ]);
    const before = client.core['history'].list().length;

    await run({ collectionId });
    const after = client.core['history'].list();
    expect(after.length).toBe(before + 2);
    expect(after.slice(0, 2).map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['History A', 'History B'])
    );
  });

  it('rejects an unknown collection instead of reporting an empty pass', async () => {
    const { run: summary, error } = await run({ collectionId: 'does-not-exist' });
    expect(summary).toBeUndefined();
    expect(error?.message).toContain('Collection not found');
  });
});

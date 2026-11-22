import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startMockApi, type MockApi } from '../../src/testing/mockApiServer';
import { createTestClient, type TestClient } from '../helpers/harness';

let api: MockApi;
let client: TestClient;

/**
 * Writes a file into the headless host and imports it through the public `importFromPath` entry
 * point — the same path the "Import Collection" command uses after the file picker.
 */
async function importText(text: string, name: string): Promise<void> {
  const path = `/virtual/${name}`;
  client.host.files.set(path, new Uint8Array(Buffer.from(text, 'utf8')));
  await client.core.importFromPath(path);
}

beforeAll(async () => {
  api = await startMockApi();
  client = createTestClient();
});
afterAll(async () => {
  client?.dispose();
  await api.close();
});

const POSTMAN_COLLECTION = {
  info: { name: 'Imported API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
  item: [
    {
      name: 'Health',
      item: [
        {
          name: 'Ping',
          request: {
            method: 'GET',
            header: [{ key: 'Accept', value: 'application/json' }],
            url: { raw: '{{baseUrl}}/health', host: ['{{baseUrl}}'], path: ['health'] }
          },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => pm.expect(pm.response.code).to.equal(200));'] } }]
        }
      ]
    },
    {
      name: 'Create',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: '{"name":"x"}' },
        url: { raw: '{{baseUrl}}/api/v1/products', host: ['{{baseUrl}}'], path: ['api', 'v1', 'products'] }
      }
    }
  ]
};

describe('import and export', () => {
  it('imports a Postman collection with folders, scripts and bodies', async () => {
    await importText(JSON.stringify(POSTMAN_COLLECTION), 'postman.json');
    const collection = client.core.collections.listCollections().find((entry) => entry.name === 'Imported API');
    expect(collection).toBeDefined();
    const requests = client.core.collections.listRequests(collection!.id);
    expect(requests).toHaveLength(2);
    const create = requests.find((request) => request.name === 'Create')!;
    expect(create.method).toBe('POST');
    expect(create.body.raw).toContain('"name"');
    const ping = requests.find((request) => request.name === 'Ping')!;
    expect(ping.scripts.tests).toContain('pm.test');
  });

  it('exports collections as sanitised JSON', async () => {
    const collection = client.core.collections.listCollections().find((entry) => entry.name === 'Imported API')!;
    await client.core.exportCollection(collection.id, true);
    // The headless host captures the written file instead of showing a save dialog.
    const written = [...client.host.files.entries()].find(([path]) => path.endsWith('.ely.json'));
    expect(written).toBeDefined();
    const exported = Buffer.from(written![1]).toString('utf8');
    const parsed = JSON.parse(exported);
    expect(parsed.collections?.[0]?.name ?? parsed.info?.name).toBeDefined();
    expect(exported).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{8,}/);
  });

  it('imports a cURL command', async () => {
    await importText(
      `curl -X POST '${api.url}/api/v1/products' -H 'Content-Type: application/json' -d '{"name":"FromCurl"}'`,
      'command.curl'
    );
    const collection = client.core.collections.listCollections().find((entry) => entry.name.includes('curl')) ?? client.core.collections.listCollections().at(-1)!;
    const request = client.core.collections.listRequests(collection.id)[0];
    expect(request.method).toBe('POST');
    expect(request.body.raw).toContain('FromCurl');
  });

  it('imports an OpenAPI 3 document', async () => {
    const openapi = {
      openapi: '3.0.0',
      info: { title: 'Pet Store', version: '1.0.0' },
      servers: [{ url: 'https://petstore.example.com/v1' }],
      paths: {
        '/pets': {
          get: { operationId: 'listPets', summary: 'List pets', responses: { 200: { description: 'ok' } } },
          post: { operationId: 'createPet', summary: 'Create pet', responses: { 201: { description: 'created' } } }
        }
      }
    };
    await importText(JSON.stringify(openapi), 'openapi.json');
    const collection = client.core.collections.listCollections().find((entry) => entry.name.includes('Pet Store'))!;
    expect(collection).toBeDefined();
    expect(client.core.collections.listRequests(collection.id)).toHaveLength(2);
  });

  it('rejects import of unsupported or malformed payloads', async () => {
    await expect(importText('{"nope":true}', 'broken.json')).rejects.toThrow();
    await expect(importText('not json at all', 'garbage.json')).rejects.toThrow(/Unrecognised file format/);
    // Oversized payloads are rejected before parsing.
    client.host.files.set('/virtual/huge.json', new Uint8Array(11 * 1024 * 1024));
    await expect(client.core.importFromPath('/virtual/huge.json')).rejects.toThrow(/import limit/);
  });
});

describe('collection lifecycle', () => {
  it('creates, renames, duplicates and deletes without orphaning requests', async () => {
    const collection = client.core.collections.createCollection('Temp');
    const request = client.core.collections.createRequest({ name: 'Alpha', collectionId: collection.id });
    expect(client.core.collections.listRequests(collection.id)).toHaveLength(1);

    client.core.collections.updateCollection(collection.id, { name: 'Renamed' });
    expect(client.core.collections.getCollection(collection.id)?.name).toBe('Renamed');

    const copy = client.core.collections.duplicateCollection(collection.id);
    expect(copy).toBeDefined();
    expect(client.core.collections.listRequests(copy!.id)).toHaveLength(1);

    client.core.collections.deleteRequest(request.id);
    expect(client.core.collections.listRequests(collection.id)).toHaveLength(0);

    await client.core.collections.deleteCollection(collection.id);
    expect(client.core.collections.getCollection(collection.id)).toBeUndefined();
  });

  it('creates nested folders', async () => {
    const collection = client.core.collections.createCollection('Nested');
    const outer = client.core.collections.createFolder(collection.id, 'Outer', null)!;
    const inner = client.core.collections.createFolder(collection.id, 'Inner', outer.id)!;
    expect(inner.parentFolderId).toBe(outer.id);
    expect(client.core.collections.listFolders(collection.id)).toHaveLength(2);
  });
});

describe('history', () => {
  it('records sends and can be cleared', async () => {
    const before = client.core.history.list().length;
    const request = await client.core.createDraftRequest();
    request.url = `${api.url}/health/live`;
    const finished = client.waitFor('request:finished', (message) => message.requestId === request.id);
    await client.send({ type: 'request:send', requestId: request.id, payload: { request } });
    await finished;
    await client.waitFor('state:snapshot');
    expect(client.core.history.list().length).toBeGreaterThan(before);
    client.core.history.clear();
    expect(client.core.history.list().length).toBe(0);
  });
});

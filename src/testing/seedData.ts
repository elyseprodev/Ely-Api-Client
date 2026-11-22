import type { AppCore } from '../services/AppCore';
import type { ApiRequest } from '../models/types';
import { newKeyValueRow } from '../models/types';
import { createRequest, nowIso } from '../models/Request';

/**
 * Creates a realistic demo workspace for the UI harness (also used to capture README screenshots).
 * Everything is created through the public controller/service APIs, so the seed data exercises the
 * same code paths as real user actions.
 */

function row(key: string, value: string, extra: Partial<ReturnType<typeof newKeyValueRow>> = {}) {
  return newKeyValueRow({ key, value, ...extra });
}

export async function seedHarnessData(controller: AppCore, mockApiUrl = 'http://localhost:4000'): Promise<void> {
  const { collections, environments } = controller;

  // ---------------------------------------------------------------- environments
  const local = environments.create('Local');
  await environments.saveVariables(local.id, [
    { id: 'var-base-local', key: 'baseUrl', value: mockApiUrl, enabled: true },
    { id: 'var-version', key: 'apiVersion', value: 'v1', enabled: true },
    { id: 'var-token', key: 'apiToken', value: 'demo-token-value', enabled: true, secret: true },
    { id: 'var-user', key: 'userId', value: '42', enabled: true }
  ]);

  const staging = environments.create('Staging');
  await environments.saveVariables(staging.id, [
    { id: 'var-base-staging', key: 'baseUrl', value: 'https://staging.acme.dev', enabled: true },
    { id: 'var-version', key: 'apiVersion', value: 'v2', enabled: true },
    { id: 'var-token', key: 'apiToken', value: 'staging-secret-token', enabled: true, secret: true }
  ]);

  const production = environments.create('Production');
  await environments.saveVariables(production.id, [
    { id: 'var-base-prod', key: 'baseUrl', value: 'https://api.acme.dev', enabled: true },
    { id: 'var-version', key: 'apiVersion', value: 'v2', enabled: true }
  ]);
  environments.setActive(local.id);

  // ---------------------------------------------------------------- collections
  const commerce = collections.createCollection('Acme Commerce API');
  collections.updateCollection(commerce.id, {
    description: 'Customer-facing storefront endpoints. All requests expect a JSON API response.'
  });
  const catalog = collections.createFolder(commerce.id, 'Catalog');
  const orders = collections.createFolder(commerce.id, 'Orders');
  if (catalog) {
    collections.updateFolder(catalog.id, { description: 'Products, categories and pricing' });
  }
  const payments = catalog ? collections.createFolder(commerce.id, 'Payments', catalog.id) : undefined;

  const add = (partial: Partial<ApiRequest> & { name: string; method: ApiRequest['method']; url: string; folderId?: string | null }): ApiRequest => {
    const request = createRequest({
      name: partial.name,
      method: partial.method,
      url: partial.url,
      collectionId: commerce.id,
      folderId: partial.folderId ?? null
    });
    return collections.saveRequest({
      ...request,
      ...partial,
      id: request.id,
      collectionId: commerce.id,
      params: partial.params ?? [],
      headers: partial.headers ?? [],
      auth: partial.auth ?? { type: 'none' },
      body: partial.body ?? { type: 'none', raw: '', form: [] },
      scripts: partial.scripts ?? { preRequest: '', tests: '' },
      description: partial.description ?? ''
    });
  };

  add({
    name: 'List products',
    method: 'GET',
    url: '{{baseUrl}}/api/{{apiVersion}}/products',
    folderId: catalog?.id ?? null,
    description: 'Paginated product catalogue used by the storefront grid.',
    params: [row('page', '1'), row('limit', '20'), row('category', 'electronics', { enabled: false })],
    headers: [row('Accept', 'application/json'), row('X-Request-Id', '{{userId}}-list-products')],
    scripts: {
      preRequest: '',
      tests: [
        'pm.test("Status code is 200", () => {',
        '  pm.response.to.have.status(200);',
        '});',
        '',
        'pm.test("Responds in under 500 ms", () => {',
        '  pm.expect(pm.response.responseTime).to.be.below(500);',
        '});',
        '',
        'pm.test("Returns an array of products", () => {',
        '  const body = pm.response.json();',
        '  pm.expect(body.items).to.be.an("array");',
        '  pm.expect(body.items.length).to.be.above(0);',
        '});'
      ].join('\n')
    }
  });

  add({
    name: 'Get product by id',
    method: 'GET',
    url: '{{baseUrl}}/api/{{apiVersion}}/products/{{userId}}',
    folderId: catalog?.id ?? null,
    headers: [row('Accept', 'application/json')]
  });

  add({
    name: 'Search products',
    method: 'GET',
    url: '{{baseUrl}}/api/{{apiVersion}}/products/search',
    folderId: catalog?.id ?? null,
    params: [row('q', 'mechanical keyboard'), row('sort', 'price:asc')]
  });

  add({
    name: 'Create product',
    method: 'POST',
    url: '{{baseUrl}}/api/{{apiVersion}}/products',
    folderId: catalog?.id ?? null,
    auth: { type: 'bearer', prefix: 'Bearer ', token: '', secretRef: 'auth:seed-create-product' },
    headers: [row('Content-Type', 'application/json'), row('Idempotency-Key', 'product-{{userId}}-001')],
    body: {
      type: 'json',
      raw: JSON.stringify(
        {
          name: 'Aurora Mechanical Keyboard',
          sku: 'ACM-KB-001',
          price: { amount: 14900, currency: 'USD' },
          attributes: { switches: 'tactile', layout: 'iso' },
          tags: ['keyboards', 'peripherals']
        },
        null,
        2
      ),
      form: []
    },
    scripts: {
      preRequest: '',
      tests: 'pm.test("Created", () => {\n  pm.response.to.have.status(201);\n});\n'
    }
  });

  add({
    name: 'List orders',
    method: 'GET',
    url: '{{baseUrl}}/api/{{apiVersion}}/orders',
    folderId: orders?.id ?? null,
    params: [row('status', 'open'), row('from', '2026-01-01')],
    headers: [row('Accept', 'application/json')]
  });

  add({
    name: 'Create order',
    method: 'POST',
    url: '{{baseUrl}}/api/{{apiVersion}}/orders',
    folderId: orders?.id ?? null,
    auth: { type: 'api-key', keyName: 'X-API-Key', keyValue: '', keyLocation: 'header', secretRef: 'auth:seed-create-order' },
    body: {
      type: 'json',
      raw: JSON.stringify(
        {
          customerId: '{{userId}}',
          items: [
            { sku: 'ACM-KB-001', quantity: 1 },
            { sku: 'ACM-MS-014', quantity: 2 }
          ],
          shipping: { country: 'RW', city: 'Kigali', method: 'express' }
        },
        null,
        2
      ),
      form: []
    }
  });

  add({
    name: 'Update order status',
    method: 'PATCH',
    url: '{{baseUrl}}/api/{{apiVersion}}/orders/1001',
    folderId: orders?.id ?? null,
    body: { type: 'json', raw: '{\n  "status": "fulfilled"\n}', form: [] }
  });

  add({
    name: 'Delete order',
    method: 'DELETE',
    url: '{{baseUrl}}/api/{{apiVersion}}/orders/1001',
    folderId: orders?.id ?? null
  });

  add({
    name: 'Charge card',
    method: 'POST',
    url: '{{baseUrl}}/api/{{apiVersion}}/payments/charge',
    folderId: payments?.id ?? null,
    auth: { type: 'basic', username: 'service-account', password: '', secretRef: 'auth:seed-charge' },
    body: {
      type: 'form-urlencoded',
      raw: '',
      form: [
        { ...row('amount', '14900'), type: 'text' as const },
        { ...row('currency', 'USD'), type: 'text' as const },
        { ...row('orderId', '1001'), type: 'text' as const }
      ]
    }
  });

  add({
    name: 'Payment webhook (multipart)',
    method: 'POST',
    url: '{{baseUrl}}/api/{{apiVersion}}/payments/webhook',
    folderId: payments?.id ?? null,
    body: {
      type: 'form-data',
      raw: '',
      form: [
        { ...row('event', 'payment.succeeded'), type: 'text' as const },
        { ...row('payload', ''), type: 'file' as const, filePath: '${workspaceFolder}/fixtures/payment.json' }
      ]
    }
  });

  // Second collection: a growing API surface with various auth strategies.
  const platform = collections.createCollection('Platform / Internal');
  collections.updateCollection(platform.id, {
    description: 'Internal service mesh endpoints. OAuth 2.0 client credentials for machine-to-machine calls.'
  });
  const health = collections.createFolder(platform.id, 'Health');
  if (health) {
    collections.updateFolder(health.id, { description: 'Liveness and readiness probes' });
  }
  const makeIn = (name: string, method: ApiRequest['method'], url: string, folderId: string | null, extra: Partial<ApiRequest> = {}) => {
    const request = createRequest({ name, method, url, collectionId: platform.id, folderId });
    collections.saveRequest({ ...request, ...extra, collectionId: platform.id });
  };
  makeIn('Liveness probe', 'GET', '{{baseUrl}}/health/live', health?.id ?? null);
  makeIn('Readiness probe', 'GET', '{{baseUrl}}/health/ready', health?.id ?? null, {
    scripts: { preRequest: '', tests: 'pm.test("Ready", () => pm.response.to.have.status(200));' }
  });
  makeIn('Exchange OAuth token', 'POST', '{{baseUrl}}/oauth/token', null, {
    auth: {
      type: 'oauth2',
      oauth2: {
        grantType: 'client-credentials',
        tokenUrl: '{{baseUrl}}/oauth/token',
        clientId: 'ely-demo-client',
        clientSecret: '',
        scope: 'orders:read orders:write',
        clientAuth: 'header'
      },
      secretRef: 'auth:seed-oauth'
    }
  });

  // ---------------------------------------------------------------- secrets
  await controller.secrets.store('auth:seed-create-product', 'demo-bearer-token-123456');
  await controller.secrets.store('auth:seed-create-order', 'demo-api-key-abcdef');
  await controller.secrets.store('auth:seed-charge', 'service-account:super-secret-password');
  await controller.secrets.store('auth:seed-oauth', 'demo-client-secret');

  // ---------------------------------------------------------------- history
  const demoHistory = [
    { name: 'List products', method: 'GET' as const, url: 'http://localhost:4000/api/v1/products?page=1&limit=20', status: 200, statusText: 'OK', duration: 84, size: 4821, ago: 1000 * 60 * 3 },
    { name: 'Create order', method: 'POST' as const, url: 'http://localhost:4000/api/v1/orders', status: 201, statusText: 'Created', duration: 142, size: 912, ago: 1000 * 60 * 26 },
    { name: 'Get product by id', method: 'GET' as const, url: 'http://localhost:4000/api/v1/products/42', status: 404, statusText: 'Not Found', duration: 31, size: 210, ago: 1000 * 60 * 71 },
    { name: 'Liveness probe', method: 'GET' as const, url: 'https://staging.acme.dev/health/live', status: 200, statusText: 'OK', duration: 12, size: 38, ago: 1000 * 60 * 60 * 5 },
    { name: 'Charge card', method: 'POST' as const, url: 'http://localhost:4000/api/v1/payments/charge', error: 'The connection was refused by the server.', duration: 8, ago: 1000 * 60 * 60 * 26 }
  ];
  for (const entry of demoHistory) {
    const request = createRequest({ name: entry.name, method: entry.method, url: entry.url });
    controller.history.record(request, {
      requestId: request.id,
      resolved: { method: entry.method, url: entry.url, headers: [] },
      durationMs: entry.duration,
      response: entry.error
        ? undefined
        : {
            status: entry.status ?? 0,
            statusText: entry.statusText ?? '',
            httpVersion: '1.1',
            headers: [{ key: 'content-type', value: 'application/json' }],
            bodyKind: 'json',
            body: '{}',
            sizeBytes: entry.size ?? 0,
            truncated: false,
            durationMs: entry.duration,
            redirects: [],
            finalUrl: entry.url,
            contentType: 'application/json',
            cookies: [],
            timings: { start: 0, firstByte: entry.duration, total: entry.duration },
            receivedAt: new Date(Date.now() - entry.ago).toISOString()
          },
      error: entry.error ? { kind: 'connection', message: entry.error } : undefined
    });
    // Adjust timestamps for a realistic spread.
    const history = controller.history.list();
    const latest = history[0];
    if (latest) {
      (latest as { createdAt: string }).createdAt = new Date(Date.now() - entry.ago).toISOString();
    }
  }
  // Re-persist with the adjusted timestamps.
  controller.history.configure({ limit: 100 });
  await controller.broadcastState();
  void nowIso;
}

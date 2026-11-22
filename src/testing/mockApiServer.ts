/**
 * Local mock HTTP + WebSocket API used by integration tests and the UI harness.
 *
 * Provides deterministic JSON endpoints covering the response shapes the client must handle:
 * pagination, echo, slow responses, redirects, gzip, binary data, cookies, 4xx/5xx errors and a
 * WebSocket echo endpoint. Nothing here ever touches the public internet.
 */
import * as http from 'node:http';
import * as zlib from 'node:zlib';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';

export interface MockApi {
  url: string;
  port: number;
  requests: { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
  /** Sends a text message to every connected WebSocket client. */
  broadcast(message: string): void;
}

interface MockOptions {
  /** Artificial delay for /slow/:ms endpoints (default 5000 ms). */
  slowDelayMs?: number;
}

const PRODUCTS = [
  {
    id: 42,
    sku: 'ACM-KB-001',
    name: 'Aurora Mechanical Keyboard',
    price: { amount: 14900, currency: 'USD' },
    attributes: { switches: 'tactile', layout: 'iso' },
    tags: ['keyboards', 'peripherals'],
    inStock: true
  },
  {
    id: 43,
    sku: 'ACM-MS-014',
    name: 'Nimbus Wireless Mouse',
    price: { amount: 5900, currency: 'USD' },
    attributes: { dpi: 26000, buttons: 7 },
    tags: ['mice', 'peripherals'],
    inStock: true
  },
  {
    id: 44,
    sku: 'ACM-HD-021',
    name: 'Cirrus Studio Headphones',
    price: { amount: 21900, currency: 'USD' },
    attributes: { impedance: 32, wireless: true },
    tags: ['audio'],
    inStock: false
  }
];

export async function startMockApi(options: MockOptions = {}): Promise<MockApi> {
  const requests: MockApi['requests'] = [];
  const sockets = new Set<import('ws').WebSocket>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body });
      route(req, res, url, body);
    });
  });

  function json(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
    const data = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(data.length),
      'X-Mock-Server': 'ely-harness',
      ...headers
    });
    res.end(data);
  }

  function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, body: string): void {
    const path = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    if (path === '/health/live' || path === '/health/ready') {
      json(res, 200, { status: 'ok', service: 'acme-commerce', uptime: 123456, checks: { database: 'up', cache: 'up' } });
      return;
    }
    if ((path === '/api/v1/products' || path === '/api/v2/products') && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      json(res, 200, {
        items: PRODUCTS.slice(0, Math.max(1, Math.min(limit, PRODUCTS.length))),
        page,
        limit,
        total: 1284,
        hasMore: page * limit < 1284,
        links: { self: `/api/v1/products?page=${page}&limit=${limit}`, next: `/api/v1/products?page=${page + 1}&limit=${limit}` }
      });
      return;
    }
    if (/^\/api\/v[12]\/products\/search$/.test(path)) {
      json(res, 200, { query: url.searchParams.get('q') ?? '', results: PRODUCTS.slice(0, 1), took: 7 });
      return;
    }
    const productMatch = /^\/api\/v[12]\/products\/(\d+)$/.exec(path);
    if (productMatch) {
      const id = Number(productMatch[1]);
      const product = PRODUCTS.find((item) => item.id === id);
      if (method === 'DELETE') {
        res.writeHead(204, { 'X-Mock-Server': 'ely-harness' });
        res.end();
        return;
      }
      if (product) {
        json(res, 200, product);
      } else {
        json(res, 404, { error: 'not_found', message: `Product ${id} does not exist`, requestId: 'req_8f21' });
      }
      return;
    }
    if (path === '/api/v1/products' && method === 'POST') {
      json(res, 201, { id: 1285, created: true, received: safeJson(body), location: '/api/v1/products/1285' }, { Location: '/api/v1/products/1285' });
      return;
    }
    if (path === '/api/v1/orders' && method === 'POST') {
      json(res, 201, {
        id: 1001,
        status: 'open',
        total: { amount: 26700, currency: 'USD' },
        items: safeJson(body),
        createdAt: new Date().toISOString()
      });
      return;
    }
    if (/^\/api\/v[12]\/orders\/(\d+)$/.test(path)) {
      json(res, 200, { id: 1001, status: method === 'PATCH' ? 'fulfilled' : 'open', updatedAt: new Date().toISOString() });
      return;
    }
    if (path === '/api/v1/orders' && method === 'GET') {
      json(res, 200, {
        items: [
          { id: 1001, customerId: 42, status: 'open', total: 26700 },
          { id: 1002, customerId: 7, status: 'paid', total: 14900 }
        ],
        hasMore: false
      });
      return;
    }
    if (path === '/api/v1/payments/charge' && method === 'POST') {
      json(res, 200, { charged: true, amount: 14900, currency: 'USD', body });
      return;
    }
    if (path === '/api/v1/payments/webhook' && method === 'POST') {
      // Accepts a multipart upload and reports what arrived so the seeded demo request can assert
      // that the file part was actually transmitted.
      const contentType = String(req.headers['content-type'] ?? '');
      const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
      const fields: string[] = [];
      let files = 0;
      if (boundary) {
        for (const chunk of body.split(`--${boundary}`)) {
          const disposition = /name="([^"]+)"/.exec(chunk)?.[1];
          if (!disposition) continue;
          if (/filename="/.test(chunk)) files += 1;
          else fields.push(disposition);
        }
      }
      json(res, 200, { received: true, contentType, fields, files, bytes: Buffer.byteLength(body, 'utf8') });
      return;
    }
    if (path === '/echo') {
      // Mirrors the request back so tests can assert on exactly what went over the wire.
      const query: Record<string, string> = {};
      for (const [key, value] of url.searchParams.entries()) {
        query[key] = value;
      }
      json(res, 200, { method, url: req.url, query, headers: req.headers, body: safeJson(body) ?? body });
      return;
    }
    if (path === '/slow' || path === '/api/v1/slow') {
      const delay = Number(url.searchParams.get('ms') ?? options.slowDelayMs ?? 5000);
      setTimeout(() => {
        if (!res.destroyed) {
          json(res, 200, { delayed: true, ms: delay });
        }
      }, Math.min(delay, 60000));
      return;
    }
    if (path === '/redirect') {
      const target = url.searchParams.get('to') ?? '/api/v1/products';
      res.writeHead(302, { Location: target, 'X-Mock-Server': 'ely-harness' });
      res.end();
      return;
    }
    if (path === '/redirect-chain') {
      const count = Number(url.searchParams.get('n') ?? '3');
      const next = count > 1 ? `/redirect-chain?n=${count - 1}` : '/api/v1/products';
      res.writeHead(307, { Location: next });
      res.end();
      return;
    }
    if (path === '/gzip') {
      const data = zlib.gzipSync(JSON.stringify({ compressed: true, items: PRODUCTS }));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': String(data.length) });
      res.end(data);
      return;
    }
    if (path === '/binary') {
      const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) });
      res.end(data);
      return;
    }
    if (path === '/cookies') {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Set-Cookie': ['session=abc123; Path=/; HttpOnly; SameSite=Lax', 'prefs=dark; Path=/settings; Max-Age=3600']
      });
      res.end('cookies set');
      return;
    }
    if (path === '/html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Mock page</title></head><body><h1>Hello from the mock API</h1><script>document.body.append("script ran")</script></body></html>');
      return;
    }
    if (path === '/error/500') {
      json(res, 500, { error: 'internal_server_error', message: 'Something exploded', traceId: 'trace-991' });
      return;
    }
    if (path === '/error/401') {
      json(res, 401, { error: 'unauthorized', message: 'Token expired' }, { 'WWW-Authenticate': 'Bearer realm="api"' });
      return;
    }
    if (path === '/large') {
      const size = Number(url.searchParams.get('bytes') ?? 5 * 1024 * 1024);
      const payload = { blob: 'x'.repeat(Math.max(0, size)) };
      json(res, 200, payload);
      return;
    }
    if (path === '/oauth/token' && method === 'POST') {
      json(res, 200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600, scope: 'orders:read orders:write' });
      return;
    }
    json(res, 404, { error: 'not_found', path });
  }

  function safeJson(text: string): unknown {
    if (!text) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'welcome', message: 'Connected to the mock WebSocket' }));
    socket.on('message', (data) => {
      const text = data.toString();
      if (text === 'close') {
        socket.close(1000, 'Client requested close');
        return;
      }
      socket.send(JSON.stringify({ type: 'echo', received: text, at: Date.now() }));
    });
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    broadcast(message: string) {
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) {
          socket.send(message);
        }
      }
    },
    async close() {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

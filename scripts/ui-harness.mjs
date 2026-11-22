#!/usr/bin/env node
/**
 * UI harness: runs the real ElyApiClient webview outside VS Code.
 *
 * The harness serves `media/` over HTTP and bridges webview messages to a Node child process that
 * instantiates the *real* `ExtensionController` with an in-memory VS Code API stub (see
 * src/testing/vscodeStub.ts). That makes it possible to:
 *   - visually QA the interface in a browser (also used to generate the README screenshots)
 *   - exercise the full send/save/import flows without launching an editor
 *
 * Usage: node scripts/ui-harness.mjs [--port 4173]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const portIndex = process.argv.indexOf('--port');
const PORT = portIndex > -1 ? Number(process.argv[portIndex + 1]) : Number(process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

/* ------------------------------ host process ------------------------------ */

// Browser messages contain long URLs and request bodies; the default pipe is fine but we increase
// the stdout buffer limit for large snapshots and disable stdin pause behaviour explicitly.
const MAX_LINE_BYTES = 64 * 1024 * 1024;

class HostBridge {
  constructor() {
    this.pending = [];
    this.child = null;
    this.waiters = [];
    this.logs = [];
    /** Populated from the host's `harness:mock` message (the seeded demo API). */
    this.mock = null;
  }

  start() {
    const entry = join(root, 'out', 'testing', 'harnessHost.js');
    if (!existsSync(entry)) {
      throw new Error(`Harness host not compiled. Run "npm run compile" first (expected ${entry}).`);
    }
    this.child = spawn(process.execPath, [entry], {
      cwd: root,
      env: { ...process.env, ELY_UI_HARNESS: '1', NODE_OPTIONS: `--max-old-space-size=512 --max-http-header-size=65536` },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdin.setDefaultEncoding('utf8');
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          this.dispatch(message);
        } catch {
          this.logs.push(line);
        }
      }
    });
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      this.logs.push(text);
      if (this.logs.length > 2000) {
        this.logs.splice(0, 1000);
      }
      if (process.env.ELY_HARNESS_VERBOSE) {
        process.stderr.write(`[host] ${text}`);
      }
    });
    this.child.on('exit', (code) => {
      this.logs.push(`host exited with ${code}`);
      for (const waiter of this.waiters.splice(0)) {
        waiter({ type: 'host:exit', payload: { code } });
      }
      this.logs.push(`\n[bridge] host process exited (code ${code})\n`);
    });
  }

  dispatch(message) {
    if (message && message.type === 'harness:mock' && message.payload) {
      this.mock = message.payload;
    }
    // Deliver to the browser long-poll(s) waiting for a message.
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
    } else {
      this.pending.push(message);
      if (this.pending.length > 500) {
        this.pending.shift();
      }
    }
  }

  /**
   * Next host message for a long-poll. The waiter is removed when the HTTP request aborts (page
   * reload, closed tab) so a dead poll can never swallow messages meant for the next page.
   */
  take(signal) {
    if (this.pending.length) {
      return Promise.resolve(this.pending.shift());
    }
    return new Promise((resolve) => {
      const waiter = (message) => {
        if (signal) {
          signal.removeEventListener('abort', onAbort);
        }
        resolve(message);
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

const bridge = new HostBridge();

// A dropped long-poll connection must never consume a message: the browser retries immediately
// with a new request, so handing the message to a dead response would stall the page.
process.on('uncaughtException', (error) => {
  if (error && (error.code === 'ERR_STREAM_DESTROYED' || /write after end/i.test(error.message ?? ''))) {
    return;
  }
  process.stderr.write(`harness error: ${error && error.stack ? error.stack : error}\n`);
});

/* --------------------------------- server --------------------------------- */

function safeJoin(base, target) {
  const resolved = normalize(join(base, target));
  if (!resolved.startsWith(normalize(base))) {
    return null;
  }
  return resolved;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/api/message' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      bridge.send(body);
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/poll') {
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      const message = await bridge.take(abort.signal);
      if (!message) {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(
        JSON.stringify(message)
      );
      return;
    }
    if (url.pathname === '/api/logs') {
      // Exposes the host process log so headless runs can be diagnosed without a terminal.
      const tail = Number(url.searchParams.get('tail') || 200);
      const text = bridge.logs.join('').split('\n').slice(-tail).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(text);
      return;
    }
    if (url.pathname === '/api/state') {
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ ok: true, port: PORT, mock: bridge.mock, wsUrl: bridge.mock?.wsUrl ?? null }));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      let html = await readFile(join(root, 'media', 'webview', 'index.html'), 'utf8');
      html = html
        .replace(/\{\{cspSource\}\}/g, "'self'")
        .replace(/\{\{nonce\}\}/g, 'harnessnonce')
        // The harness bridges messages over HTTP, which the extension's CSP forbids on purpose.
        .replace("connect-src 'none'", "connect-src 'self'")
        .replace('data-vscode-theme', 'data-vscode-theme')
        .replace(/\{\{styleUri\}\}/g, '/media/styles/main.css')
        .replace(
          /\{\{scripts\}\}/g,
          ['core', 'json', 'components', 'app']
            .map((name) => `<script nonce="harnessnonce" src="/media/scripts/${name}.js"></script>`)
            .join('\n')
        )
        .replace('<head>', '<head>\n    <script>window.__ELY_HARNESS__ = true;</script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html);
      return;
    }
    if (url.pathname.startsWith('/media/')) {
      const file = safeJoin(join(root, 'media'), url.pathname.slice('/media/'.length));
      if (!file || !existsSync(file)) {
        res.writeHead(404).end('Not found');
        return;
      }
      const content = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(content);
      return;
    }
    res.writeHead(404).end('Not found');
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(`Harness error: ${error.message}`);
  }
});

bridge.start();
server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`ElyApiClient UI harness running at http://localhost:${PORT}\n`);
  process.stdout.write('  webview:  /\n  messages: POST /api/message\n  poll:     GET /api/poll\n');
});

const shutdown = () => {
  bridge.child?.kill();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

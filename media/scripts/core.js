/* eslint-disable */
/**
 * ElyApiClient webview — core runtime.
 *
 * Everything in the UI is built with DOM APIs and `textContent`; `innerHTML` is never used with
 * data from API responses, users or imports. The bundle is plain scripts sharing the global
 * `Ely` namespace, loaded in dependency order by index.html (or the UI harness).
 */
(function () {
  'use strict';

  const Ely = (window.Ely = window.Ely || {});
  Ely.shared = Ely.shared || {};

  Ely.HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  Ely.BODY_TYPES = ['none', 'json', 'text', 'xml', 'form-urlencoded', 'form-data', 'binary', 'graphql'];
  Ely.AUTH_TYPES = ['none', 'bearer', 'basic', 'api-key', 'oauth2'];
  Ely.BODYLESS = ['GET', 'HEAD'];

  /* ----------------------------- DOM helpers ----------------------------- */

  /**
   * Creates an element. Children may be strings (rendered with textContent), nodes, arrays or
   * falsy values (skipped). Props are applied as properties unless listed in ATTR_KEYS.
   */
  const ATTR_KEYS = new Set(['role', 'title', 'type', 'name', 'for', 'aria-label', 'aria-hidden', 'aria-selected', 'aria-expanded', 'aria-controls', 'aria-live', 'aria-orientation', 'aria-haspopup', 'aria-current', 'role', 'tabindex', 'id', 'hidden', 'href', 'target', 'rel', 'placeholder', 'spellcheck', 'autocomplete', 'rows', 'cols', 'min', 'max', 'step', 'disabled', 'readonly', 'checked', 'selected', 'scope', 'colspan', 'value', 'pattern', 'maxlength', 'inputmode', 'accept']);

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) {
          continue;
        }
        if (key === 'class') {
          node.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
        } else if (key === 'dataset') {
          Object.assign(node.dataset, value);
        } else if (key === 'style') {
          Object.assign(node.style, value);
        } else if (key === 'on') {
          for (const [event, handler] of Object.entries(value)) {
            node.addEventListener(event, handler);
          }
        } else if (key.startsWith('aria-') || key === 'role') {
          node.setAttribute(key, String(value));
        } else if (key in node || ATTR_KEYS.has(key)) {
          if (key === 'value' && node.tagName !== 'INPUT' && node.tagName !== 'TEXTAREA' && node.tagName !== 'SELECT') {
            node.setAttribute('value', String(value));
          } else if (key === 'hidden') {
            node.hidden = Boolean(value);
          } else if (key === 'disabled' || key === 'checked' || key === 'selected' || key === 'readOnly' && false) {
            node[key] = Boolean(value);
          } else {
            try {
              node[key] = value;
            } catch {
              node.setAttribute(key, String(value));
            }
          }
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    append(node, children);
    return node;
  }

  function append(parent, children) {
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) {
        continue;
      }
      parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
  }

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  function svgIcon(path, viewBox = '0 0 24 24', options = {}) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    if (options.class) {
      svg.setAttribute('class', options.class);
    }
    const inner = document.createElementNS(ns, 'path');
    inner.setAttribute('d', path);
    inner.setAttribute('fill', options.fill || 'none');
    inner.setAttribute('stroke', options.stroke === false ? 'none' : 'currentColor');
    inner.setAttribute('stroke-width', String(options.strokeWidth || 1.6));
    inner.setAttribute('stroke-linecap', 'round');
    inner.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(inner);
    return svg;
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) {
      return '0 B';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unit]}`;
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms)) {
      return '—';
    }
    if (ms < 1000) {
      return `${Math.round(ms)} ms`;
    }
    return `${(ms / 1000).toFixed(2)} s`;
  }

  function formatRelativeTime(iso) {
    const time = Date.parse(iso);
    if (Number.isNaN(time)) {
      return '';
    }
    const diff = Date.now() - time;
    if (diff < 60000) {
      return 'just now';
    }
    if (diff < 3600000) {
      return `${Math.floor(diff / 60000)}m ago`;
    }
    if (diff < 86400000) {
      return `${Math.floor(diff / 3600000)}h ago`;
    }
    if (diff < 604800000) {
      return `${Math.floor(diff / 86400000)}d ago`;
    }
    return new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function formatClock(timestamp) {
    return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function statusTone(status) {
    if (!status) return 'muted';
    if (status >= 200 && status < 300) return 'success';
    if (status >= 300 && status < 400) return 'info';
    if (status >= 400 && status < 500) return 'warning';
    if (status >= 500) return 'error';
    return 'info';
  }

  function uid() {
    if (window.crypto && window.crypto.randomUUID) {
      return window.crypto.randomUUID();
    }
    return Math.random().toString(36).slice(2, 11);
  }

  function debounce(fn, wait) {
    let timer;
    return function debounced(...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function truncate(text, length = 60) {
    const value = String(text ?? '');
    return value.length > length ? `${value.slice(0, length - 1)}…` : value;
  }

  Ely.dom = { el, append, $, $$, clear, svgIcon, ATTR_KEYS };
  Ely.format = { bytes: formatBytes, duration: formatDuration, relativeTime: formatRelativeTime, clock: formatClock, statusTone };
  Ely.util = { uid, debounce, clamp, truncate };

  /* --------------------------- transport bridge -------------------------- */

  /**
   * Talks to the extension host. In VS Code the host is `acquireVsCodeApi()`. In the UI harness
   * (browser) the host is reached through `/api/message` -> JSON lines to a Node process.
   */
  const listeners = new Set();
  let vscodeApi = null;
  let harnessMode = false;
  let requestCounter = 1;
  const pendingHarness = new Map();

  function detectMode() {
    if (typeof window.acquireVsCodeApi === 'function') {
      vscodeApi = window.acquireVsCodeApi();
      return;
    }
    if (window.__ELY_HARNESS__) {
      harnessMode = true;
    }
  }

  function post(message) {
    if (vscodeApi) {
      vscodeApi.postMessage(message);
      return;
    }
    if (harnessMode) {
      fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      }).catch((error) => console.error('harness transport failed', error));
      return;
    }
    console.warn('No transport available; message dropped', message && message.type);
  }

  /* Long-poll loop used by the browser harness to receive host messages. */
  function startHarnessPolling() {
    if (!harnessMode) {
      return;
    }
    const tick = () =>
      fetch('/api/poll')
        .then((response) => (response.ok ? response.json() : null))
        .then((message) => {
          if (message) {
            receive(message);
          }
          setTimeout(tick, 20);
        })
        .catch(() => setTimeout(tick, 600));
    setTimeout(tick, 30);
  }

  function receive(event) {
    const data = event && event.data ? event.data : event;
    if (!data || typeof data !== 'object' || typeof data.type !== 'string') {
      return;
    }
    for (const listener of listeners) {
      try {
        listener(data);
      } catch (error) {
        console.error('listener failed', error);
      }
    }
  }

  function onMessage(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  Ely.transport = {
    post,
    receive,
    onMessage,
    detectMode,
    startHarnessPolling,
    isHarness: () => harnessMode
  };

  if (window.addEventListener) {
    window.addEventListener('message', receive);
  }

  /* ------------------------------- events -------------------------------- */

  function createEmitter() {
    const map = new Map();
    return {
      on(event, handler) {
        if (!map.has(event)) map.set(event, new Set());
        map.get(event).add(handler);
        return () => map.get(event).delete(handler);
      },
      emit(event, payload) {
        for (const handler of map.get(event) || []) {
          try {
            handler(payload);
          } catch (error) {
            console.error(`handler for ${event} failed`, error);
          }
        }
      }
    };
  }

  Ely.emitter = createEmitter;

  /* ------------------------------- storage ------------------------------- */

  const STORAGE_KEY = 'ely.client.ui';

  function loadPersistedUi() {
    try {
      const raw = vscodeApi ? vscodeApi.getState() : JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  }

  const persisted = loadPersistedUi();

  function persistUi(patch) {
    Object.assign(persisted, patch);
    try {
      const snapshot = JSON.parse(JSON.stringify(persisted));
      if (vscodeApi) {
        vscodeApi.setState(snapshot);
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      }
    } catch {
      /* persistence is best effort */
    }
  }

  Ely.store = { get: (key, fallback) => (persisted[key] === undefined ? fallback : persisted[key]), set: persistUi };

  /* -------------------------------- models ------------------------------- */

  const shared = Ely.shared;

  function newRow(partial) {
    return Object.assign({ id: uid(), enabled: true, key: '', value: '' }, partial || {});
  }

  function normalizeRow(row) {
    return {
      id: row && row.id ? row.id : uid(),
      enabled: row ? row.enabled !== false : true,
      key: row && typeof row.key === 'string' ? row.key : '',
      value: row && row.value !== undefined && row.value !== null ? String(row.value) : '',
      description: row && typeof row.description === 'string' ? row.description : ''
    };
  }

  function normalizeRequest(input) {
    const raw = input && typeof input === 'object' ? input : {};
    return {
      id: raw.id || `draft-${uid()}`,
      name: raw.name || 'Untitled Request',
      method: Ely.HTTP_METHODS.includes(String(raw.method || '').toUpperCase()) ? String(raw.method).toUpperCase() : 'GET',
      url: typeof raw.url === 'string' ? raw.url : '',
      params: Array.isArray(raw.params) ? raw.params.map(normalizeRow) : [],
      headers: Array.isArray(raw.headers) ? raw.headers.map(normalizeRow) : [],
      auth: normalizeAuth(raw.auth),
      body: normalizeBody(raw.body),
      scripts: {
        preRequest: raw.scripts && typeof raw.scripts.preRequest === 'string' ? raw.scripts.preRequest : '',
        tests: raw.scripts && typeof raw.scripts.tests === 'string' ? raw.scripts.tests : ''
      },
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : {},
      description: typeof raw.description === 'string' ? raw.description : '',
      collectionId: raw.collectionId,
      folderId: raw.folderId === undefined ? null : raw.folderId,
      sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : Date.now(),
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString()
    };
  }

  function normalizeAuth(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const type = Ely.AUTH_TYPES.includes(raw.type) ? raw.type : 'none';
    const auth = { type };
    if (typeof raw.secretRef === 'string') auth.secretRef = raw.secretRef;
    if (raw.token) auth.token = raw.token;
    if (raw.username) auth.username = raw.username;
    if (raw.password) auth.password = raw.password;
    if (raw.keyName) auth.keyName = raw.keyName;
    if (raw.keyValue) auth.keyValue = raw.keyValue;
    if (raw.keyLocation) auth.keyLocation = raw.keyLocation;
    if (raw.prefix !== undefined) auth.prefix = raw.prefix;
    if (raw.oauth2) {
      auth.oauth2 = Object.assign(
        { grantType: 'client-credentials', tokenUrl: '', clientId: '', clientSecret: '', scope: '', username: '', password: '', clientAuth: 'header' },
        raw.oauth2
      );
    }
    return auth;
  }

  function normalizeBody(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const type = Ely.BODY_TYPES.includes(raw.type) ? raw.type : 'none';
    return {
      type,
      raw: typeof raw.raw === 'string' ? raw.raw : '',
      form: Array.isArray(raw.form)
        ? raw.form.map((row) => Object.assign(normalizeRow(row), { type: row && row.type === 'file' ? 'file' : 'text', filePath: row && row.filePath }))
        : [],
      binaryPath: raw.binaryPath
    };
  }

  Ely.models = { newRow, normalizeRow, normalizeRequest, normalizeAuth, normalizeBody };

  /* -------------------------------- state -------------------------------- */

  const stateEmitter = createEmitter();

  const state = {
    snapshot: {
      collections: [],
      folders: [],
      requests: [],
      environments: [],
      activeEnvironmentId: null,
      history: [],
      settings: {
        defaultMethod: 'GET',
        timeout: 30000,
        followRedirects: 'follow',
        maxRedirects: 5,
        verifyTls: true,
        maxDisplaySize: 1048576,
        prettyPrint: true,
        theme: 'auto',
        confirmBeforeDelete: true,
        historyEnabled: true,
        historyLimit: 100,
        scriptTimeoutMs: 3000,
        allowPrivateNetwork: true,
        websocketMaxMessages: 500
      },
      tools: { websocket: null }
    },
    documents: [],
    activeId: null,
    selection: {},
    section: Ely.store.get('section', 'collections'),
    theme: Ely.store.get('theme', null),
    requestTab: 'params',
    responseTab: 'pretty',
    wrap: Ely.store.get('wrap', true),
    response: null,
    sending: false,
    historyFilter: '',
    collectionFilter: '',
    environmentEditor: null,
    websocketOpen: false,
    runnerOpen: false,
    runnerCollectionId: Ely.store.get('runnerCollectionId', null),
    run: null,
    runnerOpenRows: [],
    splitRatio: Ely.store.get('splitRatio', 0.46)
  };
  const unsaved = new Map();

  function defaultSettings() {
    return state.snapshot.settings;
  }

  function createDocument(request, options = {}) {
    const doc = {
      request: normalizeRequest(request),
      hasSecret: Boolean(options.hasSecret),
      isNew: Boolean(options.isNew),
      unsavedId: options.unsavedId || null,
      response: null,
      sending: false,
      error: null,
      startedAt: 0,
      scrollTop: 0
    };
    if (doc.unsavedId) {
      unsaved.set(doc.unsavedId, doc);
    }
    state.documents.push(doc);
    return doc;
  }

  function findDocument(id) {
    return state.documents.find((doc) => doc.request.id === id);
  }

  function activeDocument() {
    return findDocument(state.activeId);
  }

  function markDirty(doc) {
    if (!doc) return;
    doc.dirty = true;
    stateEmitter.emit('dirty', doc);
  }

  Ely.state = {
    get: () => state,
    on: stateEmitter.on,
    emit: stateEmitter.emit,
    defaultSettings,
    createDocument,
    findDocument,
    activeDocument,
    markDirty,
    unsaved
  };
})();

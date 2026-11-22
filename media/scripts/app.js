/* eslint-disable */
/**
 * ElyApiClient webview — application controller.
 *
 * Responsibilities:
 *  - render the sidebar (collections tree, history, environments), document tabs and welcome page
 *  - render the request editor (URL bar, params, headers, auth, body, scripts, settings)
 *  - render the response viewer (pretty/raw/preview/headers/cookies/tests/timing)
 *  - translate user intent into transport messages for the extension host
 *  - keep rendering incremental: only the affected region is re-rendered on state changes
 */
(function () {
  'use strict';

  const Ely = window.Ely;
  const { el, clear, $, $$ } = Ely.dom;
  const { post } = Ely.transport;
  const UI = Ely.ui;
  const stateApi = Ely.state;
  const state = stateApi.get();
  const { bytes, duration, relativeTime, clock, statusTone } = Ely.format;

  const TEMPLATES = [
    { name: 'JSONPlaceholder — List posts', method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts' },
    { name: 'JSONPlaceholder — Create post', method: 'POST', url: 'https://jsonplaceholder.typicode.com/posts' },
    { name: 'httpbin — Echo headers', method: 'GET', url: 'https://httpbin.org/headers' },
    { name: 'Local API health check', method: 'GET', url: '{{baseUrl}}/health' }
  ];

  /* ------------------------------ small helpers --------------------------- */

  function activeDoc() {
    return stateApi.activeDocument();
  }

  function settings() {
    return state.snapshot.settings;
  }

  function collectionsById() {
    const map = new Map();
    for (const collection of state.snapshot.collections) map.set(collection.id, collection);
    return map;
  }

  function foldersById() {
    const map = new Map();
    for (const folder of state.snapshot.folders) map.set(folder.id, folder);
    return map;
  }

  function requestById(id) {
    return state.snapshot.requests.find((request) => request.id === id);
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url);
      const path = `${parsed.pathname}${parsed.search}`;
      return path && path !== '/' ? `${parsed.host}${path}` : parsed.host;
    } catch {
      return String(url || '');
    }
  }

  function countEnabled(rows) {
    return rows.filter((row) => row.enabled && row.key).length;
  }

  function unresolvedVariables(text) {
    const names = new Set();
    for (const match of String(text || '').matchAll(/\{\{\s*([A-Za-z0-9_.\-$]+)\s*\}\}/g)) {
      names.add(match[1]);
    }
    return names;
  }

  function environmentVariableNames() {
    const active = state.snapshot.environments.find((env) => env.id === state.snapshot.activeEnvironmentId);
    return new Set((active ? active.variables : []).filter((v) => v.enabled && v.key).map((v) => v.key));
  }

  /* ------------------------------ render: tree ---------------------------- */

  function rowAction(iconPath, title, handler) {
    return el(
      'button',
      {
        class: 'row-action',
        type: 'button',
        title,
        'aria-label': title,
        on: {
          click: (event) => {
            event.stopPropagation();
            handler();
          }
        }
      },
      Ely.dom.svgIcon(iconPath)
    );
  }

  function renderTree() {
    const container = $('#collection-tree');
    if (!container) return;
    clear(container);
    const filter = state.collectionFilter.trim().toLowerCase();
    const collapsed = new Set(Ely.store.get('collapsed', []));

    const matchesFilter = (request) =>
      !filter ||
      request.name.toLowerCase().includes(filter) ||
      request.url.toLowerCase().includes(filter) ||
      request.method.toLowerCase() === filter;

    if (!state.snapshot.collections.length) {
      const empty = el(
        'div',
        { class: 'tree-empty' },
        el('p', null, 'No collections yet.'),
        el('p', null, 'Collections keep your requests organised and versionable through exports.'),
        el(
          'button',
          {
            class: 'button primary',
            type: 'button',
            on: { click: () => createCollection() }
          },
          'Create your first collection'
        )
      );
      container.appendChild(empty);
      return;
    }

    const requestsByCollection = new Map();
    for (const request of state.snapshot.requests) {
      const key = request.collectionId || '';
      if (!requestsByCollection.has(key)) requestsByCollection.set(key, []);
      requestsByCollection.get(key).push(request);
    }
    const foldersByCollection = new Map();
    for (const folder of state.snapshot.folders) {
      if (!foldersByCollection.has(folder.collectionId)) foldersByCollection.set(folder.collectionId, []);
      foldersByCollection.get(folder.collectionId).push(folder);
    }

    const sorted = (items) => [...items].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || a.name.localeCompare(b.name));

    const buildRequestNode = (request, depth) => {
      if (!matchesFilter(request)) return null;
      const node = el(
        'div',
        {
          class: 'tree-node',
          role: 'treeitem',
          dataset: { id: request.id },
          style: { '--indent': `${depth * 13}px` }
        },
        el(
          'div',
          {
            class: `tree-row ${state.selection.type === 'request' && state.selection.id === request.id ? 'is-selected' : ''}`,
            tabindex: '0',
            on: {
              click: () => openRequest(request.id),
              dblclick: () => openRequest(request.id),
              keydown: (event) => {
                if (event.key === 'Enter') openRequest(request.id);
                if (event.key === 'F2') renameRequest(request);
              },
              contextmenu: (event) => {
                event.preventDefault();
                requestMenu(event.currentTarget, request);
              }
            }
          },
          el('span', { class: 'twisty' }),
          el('span', { class: 'method-pill', dataset: { method: request.method } }, request.method),
          el('span', { class: 'tree-label', title: request.url }, el('strong', null, request.name)),
          el(
            'span',
            { class: 'row-actions' },
            rowAction('M12 5v14M5 12h14', 'Duplicate request', () => post({ type: 'request:duplicate', payload: { id: request.id } })),
            rowAction('M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12', 'Delete request', () => deleteRequest(request))
          )
        )
      );
      return node;
    };

    const buildFolderNode = (folder, depth) => {
      const childFolders = sorted((foldersByCollection.get(folder.collectionId) || []).filter((item) => item.parentFolderId === folder.id));
      const childRequests = sorted((requestsByCollection.get(folder.collectionId) || []).filter((item) => item.folderId === folder.id));
      const children = [
        ...childFolders.map((child) => buildFolderNode(child, depth + 1)),
        ...childRequests.map((request) => buildRequestNode(request, depth + 1))
      ].filter(Boolean);
      if (filter && !children.length) return null;
      const isCollapsed = collapsed.has(folder.id);
      return el(
        'div',
        { class: `tree-node ${isCollapsed ? 'is-collapsed' : ''}`, role: 'treeitem', 'aria-expanded': isCollapsed ? 'false' : 'true' },
        el(
          'div',
          {
            class: `tree-row ${state.selection.type === 'folder' && state.selection.id === folder.id ? 'is-selected' : ''}`,
            style: { '--indent': `${depth * 13}px` },
            tabindex: '0',
            on: {
              click: () => toggleFolder(folder.id),
              contextmenu: (event) => {
                event.preventDefault();
                folderMenu(event.currentTarget, folder);
              }
            }
          },
          el('span', { class: 'twisty' }, Ely.dom.svgIcon('M6 9l6 6 6-6', '0 0 24 24', { strokeWidth: 1.8 })),
          el('span', { class: 'tree-label' }, folder.name),
          el('span', { class: 'row-actions' }, el('span', { class: 'env-count' }, String(children.length)))
        ),
        el('div', { class: 'tree-children', role: 'group' }, children)
      );
    };

    for (const collection of sorted(state.snapshot.collections)) {
      const collectionFolders = sorted(foldersByCollection.get(collection.id) || []);
      const collectionRequests = sorted(requestsByCollection.get(collection.id) || []);
      const children = [
        ...collectionFolders.filter((folder) => !folder.parentFolderId).map((folder) => buildFolderNode(folder, 1)),
        ...collectionRequests.filter((request) => !request.folderId).map((request) => buildRequestNode(request, 1))
      ].filter(Boolean);
      if (filter && !children.length) continue;
      const isCollapsed = collapsed.has(collection.id);
      container.appendChild(
        el(
          'div',
          { class: `tree-node ${isCollapsed ? 'is-collapsed' : ''}`, role: 'treeitem', 'aria-expanded': isCollapsed ? 'false' : 'true' },
          el(
            'div',
            {
              class: `tree-row ${state.selection.type === 'collection' && state.selection.id === collection.id ? 'is-selected' : ''}`,
              tabindex: '0',
              on: {
                click: () => toggleFolder(collection.id),
                contextmenu: (event) => {
                  event.preventDefault();
                  collectionMenu(event.currentTarget, collection);
                }
              }
            },
            el('span', { class: 'twisty' }, Ely.dom.svgIcon('M6 9l6 6 6-6', '0 0 24 24', { strokeWidth: 1.8 })),
            el('span', { class: 'tree-label' }, el('strong', null, collection.name)),
            el(
              'span',
              { class: 'row-actions' },
              rowAction('M12 5v14M5 12h14', 'New request here', () => newRequestIn(collection.id, null)),
              rowAction('M4 6a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z', 'New folder', () => createFolder(collection.id, null))
            )
          ),
          el('div', { class: 'tree-children', role: 'group' }, children)
        )
      );
    }
  }

  function toggleFolder(id) {
    const collapsed = new Set(Ely.store.get('collapsed', []));
    if (collapsed.has(id)) collapsed.delete(id);
    else collapsed.add(id);
    Ely.store.set({ collapsed: [...collapsed] });
    renderTree();
  }

  function collectionMenu(anchor, collection) {
    UI.showMenu(anchor, [
      { label: 'Run collection', hint: 'Tests', onSelect: () => openRunner(collection.id) },
      { separator: true },
      { label: 'Open in new tab', onSelect: () => newRequestIn(collection.id, null) },
      { label: 'New folder', onSelect: () => createFolder(collection.id, null) },
      { label: 'Rename collection', hint: 'F2', onSelect: () => renameCollection(collection) },
      { label: 'Duplicate collection', onSelect: () => post({ type: 'collection:duplicate', payload: { id: collection.id } }) },
      { separator: true },
      { label: 'Export collection…', onSelect: () => post({ type: 'export:collection', payload: { collectionId: collection.id } }) },
      { separator: true },
      { label: 'Delete collection', danger: true, onSelect: () => post({ type: 'collection:delete', payload: { id: collection.id } }) }
    ]);
  }

  function folderMenu(anchor, folder) {
    UI.showMenu(anchor, [
      { label: 'Run folder', hint: 'Tests', onSelect: () => openRunner(folder.collectionId, folder.id) },
      { separator: true },
      { label: 'New request here', onSelect: () => newRequestIn(folder.collectionId, folder.id) },
      { label: 'New subfolder', onSelect: () => createFolder(folder.collectionId, folder.id) },
      { label: 'Rename folder', onSelect: () => renameFolder(folder) },
      { separator: true },
      { label: 'Delete folder', danger: true, onSelect: () => post({ type: 'folder:delete', payload: { id: folder.id } }) }
    ]);
  }

  function requestMenu(anchor, request) {
    UI.showMenu(anchor, [
      { label: 'Open', onSelect: () => openRequest(request.id) },
      { label: 'Duplicate', onSelect: () => post({ type: 'request:duplicate', payload: { id: request.id } }) },
      { label: 'Rename', onSelect: () => renameRequest(request) },
      { label: 'Move to collection root', onSelect: () => moveRequestToRoot(request) },
      { separator: true },
      { label: 'Copy as cURL', onSelect: () => post({ type: 'export:request-curl', payload: { request } }) },
      { separator: true },
      { label: 'Delete', danger: true, onSelect: () => deleteRequest(request) }
    ]);
  }

  /* --------------------------- render: sidebar lists --------------------- */

  function renderHistory() {
    const container = $('#history-list');
    if (!container) return;
    clear(container);
    const filter = state.historyFilter.trim().toLowerCase();
    const entries = state.snapshot.history.filter(
      (entry) => !filter || entry.url.toLowerCase().includes(filter) || entry.method.toLowerCase() === filter || entry.name.toLowerCase().includes(filter)
    );
    if (!state.snapshot.history.length) {
      container.appendChild(
        el('div', { class: 'list-empty' }, el('p', null, 'No requests yet.'), el('p', null, 'Every request you send is recorded here, with secrets redacted.'))
      );
      return;
    }
    if (!entries.length) {
      container.appendChild(el('div', { class: 'list-empty' }, 'No entries match your filter.'));
      return;
    }
    for (const entry of entries) {
      const tone = entry.error ? 'error' : statusTone(entry.statusCode);
      container.appendChild(
        el(
          'div',
          {
            class: 'history-item',
            role: 'listitem',
            title: `${entry.method} ${entry.url}`,
            on: {
              click: () => post({ type: 'request:resend-history', payload: { id: entry.id } }),
              contextmenu: (event) => {
                event.preventDefault();
                UI.showMenu(event.currentTarget, [
                  { label: 'Open & resend', onSelect: () => post({ type: 'request:resend-history', payload: { id: entry.id } }) },
                  { label: 'Copy URL', onSelect: () => copyText(entry.url) },
                  { separator: true },
                  { label: 'Remove from history', danger: true, onSelect: () => post({ type: 'history:delete', payload: { id: entry.id } }) }
                ]);
              }
            }
          },
          el('span', { class: 'method-pill', dataset: { method: entry.method } }, entry.method),
          el('span', { class: 'history-url' }, entry.url || entry.name),
          el('span', { class: 'status-dot-mini', dataset: { tone } }),
          el(
            'div',
            { class: 'history-meta' },
            el('span', null, entry.error ? 'failed' : entry.statusCode ? `${entry.statusCode}` : '—'),
            entry.durationMs ? el('span', null, duration(entry.durationMs)) : null,
            el('span', null, relativeTime(entry.createdAt))
          )
        )
      );
    }
  }

  function renderEnvironments() {
    const container = $('#environment-list');
    if (!container) return;
    clear(container);
    if (!state.snapshot.environments.length) {
      container.appendChild(
        el('div', { class: 'list-empty' }, el('p', null, 'No environments.'), el('p', null, 'Create one to reuse base URLs, tokens and constants.'))
      );
      return;
    }
    for (const environment of state.snapshot.environments) {
      const isActive = environment.id === state.snapshot.activeEnvironmentId;
      container.appendChild(
        el(
          'div',
          {
            class: `env-item ${isActive ? 'is-active' : ''}`,
            role: 'listitem',
            on: {
              click: (event) => {
                if (event.target.closest('.env-actions')) return;
                post({ type: 'environment:set-active', payload: { id: isActive ? null : environment.id } });
              }
            }
          },
          el('span', { class: 'env-dot', style: { background: isActive ? 'var(--success)' : 'var(--text-muted)', width: '7px', height: '7px', borderRadius: '50%' } }),
          el('span', { class: 'env-name' }, environment.name),
          el('span', { class: 'env-count' }, `${environment.variables.length}`),
          el(
            'span',
            { class: 'env-actions' },
            rowAction('M4 20h4L19 9l-4-4L4 16Z', 'Edit variables', () => openEnvironmentEditor(environment)),
            rowAction('M8 6h11l-3-3M16 18H5l3 3', 'Duplicate', () => post({ type: 'environment:duplicate', payload: { id: environment.id } })),
            rowAction('M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2l1-12', 'Delete', () => post({ type: 'environment:delete', payload: { id: environment.id } }))
          )
        )
      );
    }
  }

  function renderEnvironmentSelector() {
    const selector = $('#env-selector');
    const label = $('#env-selector-label');
    const active = state.snapshot.environments.find((env) => env.id === state.snapshot.activeEnvironmentId);
    label.textContent = active ? active.name : 'No environment';
    selector.classList.toggle('has-env', Boolean(active));
    const statusEnv = $('#status-env');
    if (statusEnv) statusEnv.textContent = active ? `${active.name}` : 'No environment';
  }

  function renderEnvPopover() {
    const popover = $('#env-popover');
    if (!popover || popover.hidden) return;
    clear(popover);
    popover.appendChild(el('div', { class: 'menu-label' }, 'Active environment'));
    popover.appendChild(
      el(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          on: {
            click: () => {
              post({ type: 'environment:set-active', payload: { id: null } });
              popover.hidden = true;
            }
          }
        },
        el('span', null, 'No environment'),
        state.snapshot.activeEnvironmentId ? null : el('span', { class: 'menu-hint' }, '✓')
      )
    );
    for (const environment of state.snapshot.environments) {
      const isActive = environment.id === state.snapshot.activeEnvironmentId;
      popover.appendChild(
        el(
          'button',
          {
            class: 'menu-item',
            type: 'button',
            on: {
              click: () => {
                post({ type: 'environment:set-active', payload: { id: environment.id } });
                popover.hidden = true;
              }
            }
          },
          el('span', null, environment.name),
          isActive ? el('span', { class: 'menu-hint' }, '✓') : el('span', { class: 'menu-hint' }, `${environment.variables.length} vars`)
        )
      );
    }
    popover.appendChild(el('div', { class: 'menu-separator' }));
    popover.appendChild(
      el(
        'button',
        {
          class: 'menu-item',
          type: 'button',
          on: {
            click: () => {
              popover.hidden = true;
              createEnvironment();
            }
          }
        },
        '＋ New environment'
      )
    );
    const active = state.snapshot.environments.find((env) => env.id === state.snapshot.activeEnvironmentId);
    if (active) {
      popover.appendChild(
        el(
          'button',
          {
            class: 'menu-item',
            type: 'button',
            on: {
              click: () => {
                popover.hidden = true;
                openEnvironmentEditor(active);
              }
            }
          },
          '✎ Edit variables'
        )
      );
    }
  }

  /* ---------------------------- render: documents ------------------------ */

  function renderTabs() {
    const tabs = $('#tabs');
    if (!tabs) return;
    clear(tabs);
    if (!state.documents.length) {
      // An empty strip would otherwise render an orphan "+" button above the welcome page.
      return;
    }
    for (const doc of state.documents) {
      const request = doc.request;
      const isActive = request.id === state.activeId;
      const tab = el(
        'div',
        {
          class: `doc-tab ${isActive ? 'is-active' : ''}`,
          role: 'tab',
          'aria-selected': isActive ? 'true' : 'false',
          tabindex: '0',
          title: request.url || request.name,
          on: {
            click: () => activateDocument(request.id),
            auxclick: (event) => {
              if (event.button === 1) closeDocument(request.id);
            },
            keydown: (event) => {
              if (event.key === 'Enter') activateDocument(request.id);
            }
          }
        },
        el('span', { class: 'method-pill', dataset: { method: request.method } }, request.method),
        el('span', { class: 'tab-name' }, request.name),
        doc.dirty ? el('span', { class: 'dirty-dot', title: 'Unsaved changes' }) : null,
        el(
          'button',
          {
            class: 'tab-close',
            type: 'button',
            'aria-label': 'Close tab',
            on: {
              click: (event) => {
                event.stopPropagation();
                closeDocument(request.id);
              }
            }
          },
          '✕'
        )
      );
      tabs.appendChild(tab);
    }
    tabs.appendChild(
      el(
        'button',
        {
          class: 'doc-tab-new',
          type: 'button',
          title: 'New request (Ctrl+Alt+N)',
          'aria-label': 'New request',
          on: { click: () => newRequest() }
        },
        '＋'
      )
    );
  }

  function activateDocument(id) {
    const doc = stateApi.findDocument(id);
    if (!doc) return;
    lastPanelKey = null;
    renderedResponseKey = null;
    state.activeId = id;
    state.selection = { type: 'request', id };
    renderTabs();
    // The environment manager replaces the whole pane; opening a request must bring the editor
    // back into view instead of leaving the user on the manager.
    if (state.section === 'environments' || state.websocketOpen || state.runnerOpen) {
      state.runnerOpen = false;
      selectSection('collections');
    }
    renderWorkspace();
    renderTree();
  }

  function closeDocument(id) {
    const index = state.documents.findIndex((doc) => doc.request.id === id);
    if (index === -1) return;
    state.documents.splice(index, 1);
    if (state.activeId === id) {
      const next = state.documents[index] || state.documents[index - 1] || state.documents[0];
      state.activeId = next ? next.request.id : null;
    }
    renderTabs();
    renderWorkspace();
  }

  function renderWorkspace() {
    const doc = activeDoc();
    const welcome = $('#welcome');
    const workspace = $('#request-workspace');
    const websocket = $('#websocket-workspace');
    const environments = $('#environment-workspace');
    // The environment manager owns the main pane while its rail section is selected.
    const showEnvironments = state.section === 'environments' && !state.websocketOpen;
    if (environments) environments.hidden = !showEnvironments;
    const runner = $('#runner-workspace');
    if (runner) runner.hidden = !state.runnerOpen;
    if (showEnvironments) {
      welcome.hidden = true;
      workspace.hidden = true;
      websocket.hidden = true;
      renderEnvironmentManager();
      return;
    }
    if (state.runnerOpen) {
      welcome.hidden = true;
      workspace.hidden = true;
      websocket.hidden = true;
      renderRunnerWorkspace();
      return;
    }
    if (state.websocketOpen) {
      welcome.hidden = true;
      workspace.hidden = true;
      websocket.hidden = false;
      return;
    }
    websocket.hidden = true;
    if (!doc) {
      welcome.hidden = false;
      workspace.hidden = true;
      renderWelcome();
      return;
    }
    welcome.hidden = true;
    workspace.hidden = false;
    renderRequestBar(doc);
    renderRequestTabs(doc);
    renderRequestPanel(doc);
    renderResponse(doc);
  }

  /* ----------------------------- render: welcome ------------------------- */

  function renderWelcome() {
    const templates = $('#welcome-templates');
    if (templates) {
      clear(templates);
      for (const template of TEMPLATES) {
        templates.appendChild(
          el(
            'button',
            {
              class: 'template-item',
              type: 'button',
              on: {
                click: () => {
                  const doc = stateApi.createDocument(
                    Object.assign(Ely.models.normalizeRequest({ name: template.name, method: template.method, url: template.url }), {}),
                    { isNew: true }
                  );
                  state.activeId = doc.request.id;
                  renderTabs();
                  renderWorkspace();
                }
              }
            },
            el('span', { class: 'method-pill', dataset: { method: template.method } }, template.method),
            el('span', { class: 'template-name' }, template.name, el('span', { class: 'template-url' }, template.url))
          )
        );
      }
    }
    const recent = $('#welcome-recent');
    if (recent) {
      clear(recent);
      const entries = state.snapshot.history.slice(0, 6);
      if (!entries.length) {
        recent.appendChild(el('div', { class: 'panel-hint' }, 'Requests you send will appear here.'));
      }
      for (const entry of entries) {
        recent.appendChild(
          el(
            'button',
            {
              class: 'recent-item',
              type: 'button',
              on: { click: () => post({ type: 'request:resend-history', payload: { id: entry.id } }) }
            },
            el('span', { class: 'method-pill', dataset: { method: entry.method } }, entry.method),
            el('span', { class: 'url', title: entry.url }, shortUrl(entry.url)),
            el('span', { class: 'status-dot-mini', dataset: { tone: entry.error ? 'error' : statusTone(entry.statusCode) } })
          )
        );
      }
    }
    const count = $('#status-count');
    if (count) {
      count.textContent = `${state.snapshot.collections.length} collections · ${state.snapshot.requests.length} requests`;
    }
  }

  /* ---------------------------- render: request bar ---------------------- */

  function renderRequestBar(doc) {
    const request = doc.request;
    $('#method-label').textContent = request.method;
    $('#method-select').dataset.method = request.method;
    const urlInput = $('#url-input');
    if (document.activeElement !== urlInput) {
      urlInput.value = request.url;
    }
    const nameInput = $('#request-name');
    if (document.activeElement !== nameInput) {
      nameInput.value = request.name;
    }
    $('#dirty-indicator').hidden = !doc.dirty;
    const unresolved = collectUnresolved(request);
    const warning = $('#unresolved-warning');
    if (unresolved.length) {
      warning.hidden = false;
      warning.textContent = `Missing variable${unresolved.length > 1 ? 's' : ''}: ${unresolved.join(', ')}`;
      warning.title = 'These variables are not defined in the active environment. They will be sent literally.';
    } else {
      warning.hidden = true;
    }
    const sending = doc.sending;
    $('#btn-send').hidden = sending;
    $('#btn-cancel').hidden = !sending;
    $('#request-workspace').classList.toggle('is-sending', sending);
    const progress = $('#status-progress');
    if (progress) progress.hidden = !sending;
  }

  function collectUnresolved(request) {
    const defined = environmentVariableNames();
    const found = new Set();
    const scan = (text) => {
      for (const name of unresolvedVariables(text)) {
        if (!defined.has(name)) found.add(name);
      }
    };
    scan(request.url);
    for (const row of request.params) if (row.enabled) { scan(row.key); scan(row.value); }
    for (const row of request.headers) if (row.enabled) { scan(row.key); scan(row.value); }
    scan(request.body.raw);
    for (const row of request.body.form) if (row.enabled) { scan(row.value); }
    scan(request.auth.token || request.auth.password || request.auth.keyValue || '');
    return [...found];
  }

  function renderRequestTabs(doc) {
    const request = doc.request;
    $('#count-params').textContent = String(countEnabled(request.params)) || '';
    $('#count-headers').textContent = String(countEnabled(request.headers)) || '';
    $('#dot-body').hidden = request.body.type === 'none';
    $('#dot-scripts').hidden = !(request.scripts.preRequest.trim() || request.scripts.tests.trim());
    for (const button of $$('.request-workspace .tab-item[data-tab]')) {
      const isActive = button.dataset.tab === state.requestTab;
      button.classList.toggle('is-active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    for (const panel of $$('#request-panels .request-panel')) {
      panel.hidden = panel.dataset.panel !== state.requestTab;
    }
  }

  /* ---------------------------- render: panels --------------------------- */

  let lastPanelKey = null;

  function panelKey(doc) {
    return `${doc.request.id}:${state.requestTab}:${doc.request.body.type}:${doc.request.auth.type}`;
  }

  function renderRequestPanel(doc) {
    const key = panelKey(doc);
    const panel = $(`#request-panels .request-panel[data-panel="${state.requestTab}"]`);
    if (!panel || lastPanelKey === key) {
      return;
    }
    lastPanelKey = key;
    clear(panel);
    switch (state.requestTab) {
      case 'params':
        renderParamsPanel(panel, doc);
        break;
      case 'headers':
        renderHeadersPanel(panel, doc);
        break;
      case 'auth':
        renderAuthPanel(panel, doc);
        break;
      case 'body':
        renderBodyPanel(panel, doc);
        break;
      case 'scripts':
        renderScriptsPanel(panel, doc);
        break;
      case 'settings':
        renderSettingsPanel(panel, doc);
        break;
      default:
        break;
    }
  }

  const hint = (text) => el('span', { class: 'panel-hint' }, text);
  const toolbarRow = (...children) => el('div', { class: 'panel-toolbar-row' }, ...children);

  function renderParamsPanel(panel, doc) {
    const request = doc.request;
    const disabledParams = request.url.includes('?') ? 'Query parameters already present in the URL are merged with this table. Disabled rows remove matching URL parameters.' : 'Parameters are appended to the URL. Use {{variables}} anywhere.';
    panel.appendChild(toolbarRow(hint(disabledParams), el('span', { class: 'badge' }, `${countEnabled(request.params)} enabled`)));
    const editor = UI.keyValueEditor({
      rows: request.params,
      keyPlaceholder: 'Parameter',
      valuePlaceholder: 'Value',
      addLabel: 'Add parameter',
      showDescription: true,
      onChange: (rows) => {
        request.params = rows;
        stateApi.markDirty(doc);
        $('#count-params').textContent = String(countEnabled(rows)) || '';
        renderRequestBar(doc);
      }
    });
    panel.appendChild(editor.node);
    const preview = el('div', { class: 'panel-hint', style: { marginTop: '10px', fontFamily: 'var(--font-mono)' } });
    const updatePreview = () => {
      preview.textContent = buildPreviewUrl(request);
    };
    updatePreview();
    editor.node.addEventListener('keyup', updatePreview);
    panel.appendChild(preview);
  }

  function buildPreviewUrl(request) {
    const base = request.url || 'https://api.example.com/v1/resource';
    const enabled = request.params.filter((row) => row.enabled && row.key.trim());
    if (!enabled.length) return `→ ${base}`;
    const query = enabled.map((row) => `${encodeURIComponent(row.key.trim())}=${encodeURIComponent(row.value)}`).join('&');
    return `→ ${base.split('?')[0]}?${query}`;
  }

  function renderHeadersPanel(panel, doc) {
    const request = doc.request;
    const autoHeaders = [
      ['Accept', '*/*'],
      ['User-Agent', 'ElyApiClient/0.1'],
      ['Accept-Encoding', 'identity']
    ];
    if (request.body.type !== 'none' && !['GET', 'HEAD'].includes(request.method)) {
      autoHeaders.push(['Content-Type', contentTypeFor(request.body.type)]);
    }
    panel.appendChild(
      toolbarRow(
        hint('Custom headers replace defaults with the same name. Authorization headers come from the Authorization tab.'),
        el('span', { class: 'badge' }, `${countEnabled(request.headers)} enabled`)
      )
    );
    const editor = UI.keyValueEditor({
      rows: request.headers,
      keyPlaceholder: 'Header',
      valuePlaceholder: 'Value',
      addLabel: 'Add header',
      showDescription: true,
      onChange: (rows) => {
        request.headers = rows;
        stateApi.markDirty(doc);
        $('#count-headers').textContent = String(countEnabled(rows)) || '';
      }
    });
    panel.appendChild(editor.node);
    const auto = el('div', { style: { marginTop: '12px' } }, el('div', { class: 'panel-hint', style: { marginBottom: '6px' } }, 'Headers added automatically:'));
    const autoTable = el('table', { class: 'table-view' });
    autoTable.appendChild(el('tbody', null, autoHeaders.map(([key, value]) => el('tr', null, el('td', null, key), el('td', null, value)))));
    auto.appendChild(autoTable);
    panel.appendChild(auto);
  }

  function contentTypeFor(type) {
    switch (type) {
      case 'json':
      case 'graphql':
        return 'application/json';
      case 'xml':
        return 'application/xml';
      case 'text':
        return 'text/plain';
      case 'form-urlencoded':
        return 'application/x-www-form-urlencoded';
      case 'form-data':
        return 'multipart/form-data';
      case 'binary':
        return 'application/octet-stream';
      default:
        return '—';
    }
  }

  function renderAuthPanel(panel, doc) {
    const request = doc.request;
    const grid = el('div', { class: 'auth-grid' });
    const list = el('div', { class: 'auth-types', role: 'radiogroup', 'aria-label': 'Authentication type' });
    const labels = {
      none: 'No Auth',
      bearer: 'Bearer Token',
      basic: 'Basic Auth',
      'api-key': 'API Key',
      oauth2: 'OAuth 2.0'
    };
    for (const type of Ely.AUTH_TYPES) {
      list.appendChild(
        el(
          'button',
          {
            class: `auth-type ${request.auth.type === type ? 'is-active' : ''}`,
            type: 'button',
            role: 'radio',
            'aria-checked': request.auth.type === type ? 'true' : 'false',
            on: {
              click: () => {
                request.auth = Object.assign({ type }, request.auth.type === type ? request.auth : {});
                request.auth.type = type;
                stateApi.markDirty(doc);
                lastPanelKey = null;
                renderRequestPanel(doc);
              }
            }
          },
          el('span', { class: 'auth-radio' }),
          labels[type]
        )
      );
    }
    grid.appendChild(list);
    const form = el('div', { class: 'form-grid' });
    const auth = request.auth;

    const secretHint = () => {
      if (doc.hasSecret) {
        return el(
          'div',
          { class: 'info-callout success' },
          Ely.dom.svgIcon('M5 12l4 4L19 6'),
          el('span', null, 'A credential is stored securely for this request. Leave the field blank to keep it, or type a new value to replace it.')
        );
      }
      return el(
        'div',
        { class: 'info-callout' },
        Ely.dom.svgIcon('M12 8h.01M11 12h1v4h1'),
        el('span', null, 'Credentials are saved to VS Code SecretStorage, never to collection files, exports, logs or the webview state.')
      );
    };

    const secretInput = (label, key, placeholder, value, type = 'password') =>
      el(
        'div',
        { class: 'field' },
        el('label', null, label),
        el(
          'div',
          { class: 'secret-field' },
          el('input', {
            type,
            value: value || '',
            placeholder,
            spellcheck: false,
            'aria-label': label,
            on: {
              input: (event) => {
                auth[key] = event.target.value;
                stateApi.markDirty(doc);
              }
            }
          })
        )
      );

    if (auth.type === 'none') {
      form.appendChild(
        el('div', { class: 'info-callout' }, Ely.dom.svgIcon('M5 12l4 4L19 6'), el('span', null, 'This request inherits no credentials. Add an Authorization header manually if you need something custom.'))
      );
    } else if (auth.type === 'bearer') {
      form.appendChild(secretInput('Token', 'token', doc.hasSecret ? '•••••••• stored securely' : 'Paste your bearer token', auth.secretRef && auth.token === '••••••••' ? '' : auth.token));
      form.appendChild(
        el(
          'div',
          { class: 'field' },
          el('label', null, 'Header prefix'),
          el('input', {
            type: 'text',
            value: auth.prefix === undefined ? 'Bearer ' : auth.prefix,
            spellcheck: false,
            on: {
              input: (event) => {
                auth.prefix = event.target.value;
                stateApi.markDirty(doc);
              }
            }
          }),
          el('span', { class: 'field-hint' }, 'Sent as: Authorization: Bearer <token>')
        )
      );
      form.appendChild(secretHint());
    } else if (auth.type === 'basic') {
      form.appendChild(
        el(
          'div',
          { class: 'field-row' },
          el(
            'div',
            { class: 'field' },
            el('label', null, 'Username'),
            el('input', {
              type: 'text',
              value: auth.username || '',
              spellcheck: false,
              on: {
                input: (event) => {
                  auth.username = event.target.value;
                  stateApi.markDirty(doc);
                }
              }
            })
          ),
          secretInput('Password', 'password', doc.hasSecret ? '•••••••• stored securely' : 'Password', auth.secretRef && auth.password === '••••••••' ? '' : auth.password)
        )
      );
      form.appendChild(secretHint());
    } else if (auth.type === 'api-key') {
      form.appendChild(
        el(
          'div',
          { class: 'field-row' },
          el(
            'div',
            { class: 'field' },
            el('label', null, 'Key name'),
            el('input', {
              type: 'text',
              value: auth.keyName || '',
              placeholder: 'X-API-Key',
              spellcheck: false,
              on: {
                input: (event) => {
                  auth.keyName = event.target.value;
                  stateApi.markDirty(doc);
                }
              }
            })
          ),
          el(
            'div',
            { class: 'field' },
            el('label', null, 'Add to'),
            el(
              'select',
              {
                on: {
                  change: (event) => {
                    auth.keyLocation = event.target.value;
                    stateApi.markDirty(doc);
                  }
                }
              },
              el('option', { value: 'header', selected: auth.keyLocation !== 'query' }, 'Header'),
              el('option', { value: 'query', selected: auth.keyLocation === 'query' }, 'Query parameter')
            )
          )
        )
      );
      form.appendChild(secretInput('Key value', 'keyValue', doc.hasSecret ? '•••••••• stored securely' : 'Value', auth.secretRef && auth.keyValue === '••••••••' ? '' : auth.keyValue));
      form.appendChild(secretHint());
    } else if (auth.type === 'oauth2') {
      const oauth = auth.oauth2 || (auth.oauth2 = { grantType: 'client-credentials', tokenUrl: '', clientId: '', clientSecret: '', scope: '', clientAuth: 'header' });
      form.appendChild(
        el(
          'div',
          { class: 'field' },
          el('label', null, 'Grant type'),
          el(
            'select',
            {
              on: {
                change: (event) => {
                  oauth.grantType = event.target.value;
                  stateApi.markDirty(doc);
                  lastPanelKey = null;
                  renderRequestPanel(doc);
                }
              }
            },
            el('option', { value: 'client-credentials', selected: oauth.grantType === 'client-credentials' }, 'Client Credentials (recommended)'),
            el('option', { value: 'password', selected: oauth.grantType === 'password' }, 'Resource Owner Password'),
            el('option', { value: 'authorization-code', selected: oauth.grantType === 'authorization-code' }, 'Authorization Code (not supported yet)')
          )
        )
      );
      form.appendChild(
        el(
          'div',
          { class: 'field' },
          el('label', null, 'Token URL'),
          el('input', { type: 'text', value: oauth.tokenUrl || '', placeholder: 'https://auth.example.com/oauth/token', spellcheck: false, on: { input: (e) => { oauth.tokenUrl = e.target.value; stateApi.markDirty(doc); } } })
        )
      );
      form.appendChild(
        el(
          'div',
          { class: 'field-row' },
          el('div', { class: 'field' }, el('label', null, 'Client ID'), el('input', { type: 'text', value: oauth.clientId || '', spellcheck: false, on: { input: (e) => { oauth.clientId = e.target.value; stateApi.markDirty(doc); } } })),
          el('div', { class: 'field' }, el('label', null, 'Client secret'), el('input', { type: 'password', value: oauth.clientSecret === '••••••••' ? '' : oauth.clientSecret || '', placeholder: doc.hasSecret ? '•••••••• stored securely' : '', spellcheck: false, on: { input: (e) => { oauth.clientSecret = e.target.value; stateApi.markDirty(doc); } } }))
        )
      );
      form.appendChild(
        el('div', { class: 'field' }, el('label', null, 'Scope'), el('input', { type: 'text', value: oauth.scope || '', placeholder: 'read:users write:users', spellcheck: false, on: { input: (e) => { oauth.scope = e.target.value; stateApi.markDirty(doc); } } }))
      );
      if (oauth.grantType === 'password') {
        form.appendChild(
          el(
            'div',
            { class: 'field-row' },
            el('div', { class: 'field' }, el('label', null, 'Username'), el('input', { type: 'text', value: oauth.username || '', on: { input: (e) => { oauth.username = e.target.value; stateApi.markDirty(doc); } } })),
            el('div', { class: 'field' }, el('label', null, 'Password'), el('input', { type: 'password', value: oauth.password || '', on: { input: (e) => { oauth.password = e.target.value; stateApi.markDirty(doc); } } }))
          )
        );
      }
      form.appendChild(
        el(
          'div',
          { class: 'field' },
          el('label', null, 'Client authentication'),
          el(
            'select',
            { on: { change: (e) => { oauth.clientAuth = e.target.value; stateApi.markDirty(doc); } } },
            el('option', { value: 'header', selected: oauth.clientAuth !== 'body' }, 'Send as Basic auth header'),
            el('option', { value: 'body', selected: oauth.clientAuth === 'body' }, 'Send credentials in body')
          )
        )
      );
      form.appendChild(
        el(
          'div',
          { class: 'info-callout warning' },
          Ely.dom.svgIcon('M12 8v5m0 3.5h.01'),
          el('span', null, oauth.grantType === 'authorization-code'
            ? 'The interactive browser flow is not supported yet. Use Client Credentials or paste a token with Bearer auth.'
            : 'A token is requested before each send (cached until it expires). Token endpoint errors are reported in the response panel.')
        )
      );
    }

    if (auth.type !== 'none') {
      form.appendChild(
        el(
          'div',
          { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          el(
            'button',
            {
              class: 'button secondary',
              type: 'button',
              title: 'Store the credential in VS Code SecretStorage',
              on: {
                click: () => {
                  post({ type: 'auth:store-secret', payload: { requestId: request.id, auth: JSON.parse(JSON.stringify(auth)) } });
                  UI.toast('Credential stored in SecretStorage', 'success');
                }
              }
            },
            'Store credential securely'
          ),
          el(
            'button',
            {
              class: 'button ghost',
              type: 'button',
              on: {
                click: () => {
                  post({ type: 'auth:clear-secret', payload: { requestId: request.id } });
                  doc.hasSecret = false;
                  auth.secretRef = undefined;
                  stateApi.markDirty(doc);
                  lastPanelKey = null;
                  renderRequestPanel(doc);
                  UI.toast('Stored credential removed', 'info');
                }
              }
            },
            'Remove stored credential'
          )
        )
      );
    }

    grid.appendChild(form);
    panel.appendChild(grid);
  }

  function renderBodyPanel(panel, doc) {
    const request = doc.request;
    const body = request.body;
    const toolbar = el('div', { class: 'body-toolbar' });
    toolbar.appendChild(
      UI.segmented(
        [
          { value: 'none', label: 'None' },
          { value: 'json', label: 'JSON' },
          { value: 'text', label: 'Text' },
          { value: 'xml', label: 'XML' },
          { value: 'form-urlencoded', label: 'Form URL-encoded' },
          { value: 'form-data', label: 'Multipart' },
          { value: 'graphql', label: 'GraphQL' },
          { value: 'binary', label: 'Binary' }
        ],
        body.type,
        (value) => {
          body.type = value;
          stateApi.markDirty(doc);
          document.getElementById('dot-body').hidden = value === 'none';
          clear(panel);
          renderBodyPanel(panel, doc);
        }
      )
    );
    if (['GET', 'HEAD'].includes(request.method)) {
      toolbar.appendChild(el('span', { class: 'badge warning' }, `${request.method} ignores bodies`));
    }
    panel.appendChild(toolbar);

    if (body.type === 'none') {
      panel.appendChild(
        el('div', { class: 'drop-zone' }, el('strong', null, 'No request body'), 'Select a body type above. GET and HEAD requests never send a body.')
      );
      return;
    }

    if (['json', 'text', 'xml', 'graphql'].includes(body.type)) {
      const editorWrap = el('div', { class: 'body-editor' });
      const textarea = el('textarea', {
        class: 'script-editor',
        spellcheck: false,
        placeholder: body.type === 'json' ? '{\n  "name": "Ada"\n}' : body.type === 'graphql' ? 'query { viewer { login } }' : '',
        'aria-label': 'Request body',
        on: {
          input: (event) => {
            body.raw = event.target.value;
            stateApi.markDirty(doc);
            updateValidity(event.target.value);
          },
          keydown: (event) => handleEditorKeydown(event, textarea)
        }
      });
      textarea.value = body.raw;
      editorWrap.appendChild(textarea);
      const validity = el('span', { class: 'body-validity' }, el('span', { class: 'dot' }), el('span', null, ''));
      const updateValidity = (text) => {
        if (body.type !== 'json') {
          validity.dataset.state = '';
          validity.lastChild.textContent = `${bytes(new Blob([text]).size)}`;
          return;
        }
        const result = Ely.json.formatJson(text);
        if (!text.trim()) {
          validity.dataset.state = '';
          validity.lastChild.textContent = 'empty';
        } else if (result.ok) {
          validity.dataset.state = 'valid';
          validity.lastChild.textContent = 'Valid JSON';
        } else {
          validity.dataset.state = 'invalid';
          validity.lastChild.textContent = result.error.slice(0, 80);
        }
      };
      updateValidity(body.raw);
      editorWrap.appendChild(
        el(
          'div',
          { class: 'editor-tools' },
          el(
            'div',
            { class: 'tool-group' },
            el('button', { class: 'text-button', type: 'button', on: { click: () => { const formatted = Ely.json.formatJson(body.raw); if (formatted.ok) { body.raw = formatted.text; textarea.value = formatted.text; stateApi.markDirty(doc); updateValidity(body.raw); } else UI.toast(formatted.error, 'error'); } } }, 'Format'),
            el('button', { class: 'text-button', type: 'button', on: { click: () => { const min = Ely.json.minifyJson(body.raw); if (min.ok) { body.raw = min.text; textarea.value = min.text; stateApi.markDirty(doc); updateValidity(body.raw); } } } }, 'Minify'),
            body.type === 'json'
              ? el('button', {
                  class: 'text-button',
                  type: 'button',
                  on: {
                    click: () => {
                      body.raw = '{\n  \n}';
                      textarea.value = body.raw;
                      stateApi.markDirty(doc);
                      updateValidity(body.raw);
                    }
                  }
                }, 'Template')
              : null
          ),
          validity
        )
      );
      panel.appendChild(editorWrap);
      return;
    }

    if (body.type === 'form-urlencoded' || body.type === 'form-data') {
      const editor = UI.keyValueEditor({
        rows: body.form,
        keyPlaceholder: 'Field',
        valuePlaceholder: 'Value',
        addLabel: 'Add field',
        allowFiles: body.type === 'form-data',
        onPickFile: async () => {
          return new Promise((resolve) => {
            const handler = (message) => {
              if (message.type === 'response:files') {
                unsubscribe();
                resolve((message.payload.files || [])[0] || null);
              }
            };
            const unsubscribe = Ely.transport.onMessage(handler);
            post({ type: 'request:picker-files', requestId: `pick-${Date.now()}` });
            setTimeout(() => {
              unsubscribe();
              resolve(null);
            }, 60000);
          });
        },
        onChange: (rows) => {
          body.form = rows;
          stateApi.markDirty(doc);
        }
      });
      panel.appendChild(editor.node);
      panel.appendChild(
        el('div', { class: 'panel-hint', style: { marginTop: '8px' } }, body.type === 'form-data'
          ? 'Files are read from disk when the request is sent. In Restricted Mode file uploads are blocked.'
          : 'Fields are URL-encoded and sent as application/x-www-form-urlencoded.')
      );
      return;
    }

    if (body.type === 'binary') {
      const wrap = el(
        'div',
        { class: 'drop-zone' },
        el('strong', null, 'Binary body'),
        el('div', null, body.binaryPath ? `Selected file: ${body.binaryPath}` : 'No file selected'),
        el(
          'button',
          {
            class: 'button secondary',
            type: 'button',
            style: { marginTop: '10px' },
            on: {
              click: async () => {
                const file = await new Promise((resolve) => {
                  const handler = (message) => {
                    if (message.type === 'response:files') {
                      unsubscribe();
                      resolve((message.payload.files || [])[0] || null);
                    }
                  };
                  const unsubscribe = Ely.transport.onMessage(handler);
                  post({ type: 'request:picker-files', requestId: `pick-${Date.now()}` });
                  setTimeout(() => {
                    unsubscribe();
                    resolve(null);
                  }, 60000);
                });
                if (file) {
                  body.binaryPath = file;
                  stateApi.markDirty(doc);
                  renderBodyPanel(panel, doc);
                  clear(panel);
                  renderBodyPanel(panel, doc);
                }
              }
            }
          },
          'Choose file…'
        )
      );
      panel.appendChild(wrap);
    }
  }

  function handleEditorKeydown(event, textarea) {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.value = `${textarea.value.slice(0, start)}  ${textarea.value.slice(end)}`;
    textarea.selectionStart = textarea.selectionEnd = start + 2;
    textarea.dispatchEvent(new Event('input'));
  }

  function renderScriptsPanel(panel, doc) {
    const request = doc.request;
    const grid = el('div', { class: 'script-grid' });
    const left = el('div');
    let currentTab = 'tests';
    const tabs = el('div', { class: 'script-tabs' });
    const editor = el('textarea', {
      class: 'script-editor',
      spellcheck: false,
      'aria-label': 'Script editor',
      on: {
        input: (event) => {
          request.scripts[currentTab === 'tests' ? 'tests' : 'preRequest'] = event.target.value;
          stateApi.markDirty(doc);
          document.getElementById('dot-scripts').hidden = !(request.scripts.preRequest.trim() || request.scripts.tests.trim());
        },
        keydown: (event) => handleEditorKeydown(event, editor)
      }
    });
    const sync = () => {
      editor.value = request.scripts[currentTab === 'tests' ? 'tests' : 'preRequest'];
      for (const button of tabs.children) {
        button.classList.toggle('is-active', button.dataset.script === currentTab);
      }
    };
    for (const [value, label] of [['tests', 'Tests'], ['preRequest', 'Pre-request']]) {
      tabs.appendChild(
        el(
          'button',
          {
            class: 'script-tab',
            type: 'button',
            dataset: { script: value },
            on: {
              click: () => {
                currentTab = value;
                sync();
              }
            }
          },
          label
        )
      );
    }
    sync();
    left.appendChild(tabs);
    left.appendChild(editor);
    left.appendChild(
      el(
        'div',
        { class: 'editor-tools' },
        el(
          'div',
          { class: 'tool-group' },
          el(
            'button',
            {
              class: 'text-button',
              type: 'button',
              on: {
                click: () => {
                  const template = currentTab === 'tests'
                    ? 'pm.test("Status code is 200", () => {\n  pm.response.to.have.status(200);\n});\n\npm.test("Responds in under 1s", () => {\n  pm.expect(pm.response.responseTime).to.be.below(1000);\n});\n\npm.test("Has JSON body", () => {\n  pm.expect(pm.response.json()).to.be.an("object");\n});\n'
                    : '// Runs before the request is sent.\n// pm.variables.set("token", "abc");\n';
                  const key = currentTab === 'tests' ? 'tests' : 'preRequest';
                  request.scripts[key] = request.scripts[key] ? `${request.scripts[key]}\n${template}` : template;
                  editor.value = request.scripts[key];
                  stateApi.markDirty(doc);
                }
              }
            },
            'Insert template'
          )
        ),
        el('span', { class: 'panel-hint' }, `Sandboxed · ${settings().scriptTimeoutMs} ms limit`)
      )
    );
    grid.appendChild(left);

    const docs = el(
      'div',
      { class: 'script-docs' },
      el('h4', null, 'Scripting API'),
      el('div', null, 'Scripts run in a sandboxed worker with no network, filesystem or editor access.'),
      el('code', null, 'pm.test("name", () => { ... })\npm.response.to.have.status(200)\npm.response.to.have.header("x-id")\npm.response.json()\npm.response.text()\npm.response.code\npm.response.responseTime\npm.response.headers.get("date")\npm.expect(value).to.equal(42)\npm.expect(value).to.be.an("array")\npm.expect(value).to.have.property("id", 1)\npm.expect(str).to.include("ok")\npm.expect(n).to.be.below(500)\npm.expect(v).to.be.oneOf(["a","b"])\npm.expect(s).to.match(/^v\\d+$/)\npm.variables.set("k", v)\npm.variables.get("k")\npm.environment.get("token")\nconsole.log("debug output")'),
      el('h4', { style: { marginTop: '12px' } }, 'Supported'),
      el('ul', null, el('li', null, 'pm.test, pm.expect (chai-like subset), pm.response helpers'), el('li', null, 'pm.variables / pm.environment get, set, unset'), el('li', null, 'console.log/info/warn/error (captured in Test results)')),
      el('h4', { style: { marginTop: '12px' } }, 'Not supported'),
      el('ul', null, el('li', null, 'Network calls (fetch, XMLHttpRequest), timers, dynamic eval'), el('li', null, 'pm.sendRequest, pm.iterationData, Newman CLI features'))
    );
    grid.appendChild(docs);
    panel.appendChild(grid);
  }

  function renderSettingsPanel(panel, doc) {
    const request = doc.request;
    const list = el('div', { class: 'settings-list' });
    const settingRow = (label, hintText, control) =>
      el('div', { class: 'setting-row' }, el('div', null, el('div', { class: 'setting-label' }, label), hintText ? el('div', { class: 'setting-hint' }, hintText) : null), el('div', { class: 'setting-control' }, control));

    list.appendChild(
      settingRow(
        'Timeout override',
        'Milliseconds. Empty uses the global setting. 0 disables the timeout for this request.',
        el('input', {
          type: 'number',
          min: 0,
          max: 600000,
          placeholder: String(settings().timeout),
          value: request.settings.timeoutMs === undefined ? '' : request.settings.timeoutMs,
          on: {
            input: (event) => {
              const raw = event.target.value;
              request.settings.timeoutMs = raw === '' ? undefined : Math.max(0, Number(raw) || 0);
              stateApi.markDirty(doc);
            }
          }
        })
      )
    );
    list.appendChild(
      settingRow(
        'Follow redirects',
        'Inherits the workspace default when not set.',
        el(
          'select',
          {
            on: {
              change: (event) => {
                request.settings.followRedirects = event.target.value === '' ? undefined : event.target.value === 'follow';
                stateApi.markDirty(doc);
              }
            }
          },
          el('option', { value: '', selected: request.settings.followRedirects === undefined }, `Default (${settings().followRedirects})`),
          el('option', { value: 'follow', selected: request.settings.followRedirects === true }, 'Follow'),
          el('option', { value: 'never', selected: request.settings.followRedirects === false }, 'Never')
        )
      )
    );
    list.appendChild(
      settingRow(
        'Verify TLS',
        'Disabling certificate verification is insecure. Prefer fixing the certificate.',
        el(
          'select',
          {
            on: {
              change: (event) => {
                request.settings.verifyTls = event.target.value === '' ? undefined : event.target.value === 'true';
                stateApi.markDirty(doc);
              }
            }
          },
          el('option', { value: '', selected: request.settings.verifyTls === undefined }, `Default (${settings().verifyTls ? 'verify' : 'skip'})`),
          el('option', { value: 'true', selected: request.settings.verifyTls === true }, 'Verify'),
          el('option', { value: 'false', selected: request.settings.verifyTls === false }, 'Skip verification')
        )
      )
    );
    const details = el(
      'div',
      { class: 'info-callout' },
      Ely.dom.svgIcon('M12 8h.01M11 12h1v4h1'),
      el('span', null, `Display limit ${bytes(settings().maxDisplaySize)} · Script timeout ${settings().scriptTimeoutMs} ms · Private network ${settings().allowPrivateNetwork ? 'allowed' : 'blocked'}. Change these in ElyApiClient settings.`)
    );
    list.appendChild(details);
    panel.appendChild(list);
  }

  /* --------------------------- render: response -------------------------- */

  function renderResponse(doc) {
    const empty = $('#response-empty');
    const loading = $('#response-loading');
    const content = $('#response-content');
    if (!doc) return;
    if (doc.sending && !doc.response) {
      empty.hidden = true;
      loading.hidden = false;
      content.hidden = true;
      return;
    }
    loading.hidden = true;
    const hasError = doc.error;
    const response = doc.response;
    if (!response && !hasError) {
      empty.hidden = false;
      content.hidden = true;
      return;
    }
    empty.hidden = true;
    content.hidden = false;
    renderStatus(doc);
    renderError(doc);
    renderResponseTabs(doc);
    renderResponseView(doc);
  }

  function renderStatus(doc) {
    const response = doc.response;
    const code = $('#status-code');
    const text = $('#status-text');
    if (response) {
      code.textContent = String(response.status);
      code.dataset.tone = statusTone(response.status);
      text.textContent = response.statusText || '';
      $('#metric-time').textContent = duration(response.durationMs);
      $('#metric-size').textContent = bytes(response.sizeBytes);
      const contentType = (response.contentType || '').split(';')[0];
      $('#metric-type').textContent = contentType || '—';
      $('#metric-time').parentElement.hidden = false;
    } else {
      code.textContent = 'ERR';
      code.dataset.tone = 'error';
      text.textContent = doc.error && doc.error.kind ? doc.error.kind : 'Request failed';
      $('#metric-time').textContent = '—';
      $('#metric-size').textContent = '—';
      $('#metric-type').textContent = '—';
    }
    $('#count-resp-headers').textContent = response && response.headers ? String(response.headers.length) : '';
    $('#count-cookies').textContent = response && response.cookies ? String(response.cookies.length) : '';
    const tests = doc.tests;
    const badge = $('#test-badge');
    if (tests && tests.results.length) {
      badge.hidden = false;
      badge.textContent = `${tests.passed}/${tests.results.length}`;
      badge.className = `test-badge ${tests.failed ? 'fail' : 'pass'}`;
    } else if (tests && tests.error) {
      badge.hidden = false;
      badge.textContent = 'error';
      badge.className = 'test-badge fail';
    } else {
      badge.hidden = true;
    }
  }

  function renderError(doc) {
    const panel = $('#error-panel');
    if (!doc.error) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    $('#error-title').textContent = errorTitle(doc.error.kind);
    $('#error-message').textContent = doc.error.message || 'The request failed.';
    const hintNode = $('#error-hint');
    if (doc.error.hint) {
      hintNode.hidden = false;
      hintNode.textContent = doc.error.hint;
    } else {
      hintNode.hidden = true;
    }
  }

  function errorTitle(kind) {
    const titles = {
      'invalid-url': 'Invalid URL',
      'blocked-address': 'Blocked destination',
      timeout: 'Request timed out',
      cancelled: 'Request cancelled',
      dns: 'Host not found',
      connection: 'Connection failed',
      tls: 'TLS / certificate error',
      'too-large': 'Response too large',
      'too-many-redirects': 'Too many redirects',
      file: 'File error',
      unknown: 'Request failed'
    };
    return titles[kind] || 'Request failed';
  }

  function renderResponseTabs(doc) {
    const response = doc.response;
    const unavailable = !response;
    for (const button of $$('.response-tabs .tab-item[data-rtab]')) {
      const tab = button.dataset.rtab;
      button.disabled = unavailable && tab !== 'tests';
      button.classList.toggle('is-active', tab === state.responseTab);
      button.setAttribute('aria-selected', tab === state.responseTab ? 'true' : 'false');
    }
    for (const view of $$('.response-view')) {
      view.hidden = view.dataset.rview !== state.responseTab;
    }
  }

  let renderedResponseKey = null;

  function renderResponseView(doc) {
    const response = doc.response;
    const tab = state.responseTab;
    const key = `${doc.request.id}:${tab}:${response ? response.receivedAt : doc.error ? doc.error.message : ''}:${state.wrap}:${state.searchQuery || ''}`;
    if (renderedResponseKey === key) return;
    renderedResponseKey = key;
    const view = $(`.response-view[data-rview="${tab}"]`);
    if (!view) return;
    clear(view);
    const scrollTop = view.scrollTop;
    switch (tab) {
      case 'pretty':
        renderPretty(view, response, doc);
        break;
      case 'raw':
        renderRaw(view, response);
        break;
      case 'preview':
        view.appendChild(Ely.view.buildPreview(response, settings()));
        break;
      case 'headers':
        if (response) {
          if (response.truncated) {
            view.appendChild(el('div', { class: 'truncation-notice' }, `Body truncated for display (${bytes(response.sizeBytes)} received).`));
          }
          view.appendChild(Ely.view.headerTable(response.headers, { maskSensitive: true }));
        }
        break;
      case 'cookies':
        if (response) view.appendChild(Ely.view.cookieTable(response.cookies));
        break;
      case 'tests':
        view.appendChild(
          Ely.view.testResults(doc.tests, { hasScript: Boolean(doc.request.scripts.tests.trim()) })
        );
        break;
      case 'timing':
        view.appendChild(Ely.view.timingChart(response));
        break;
      default:
        break;
    }
    view.scrollTop = scrollTop;
    updateSearchCount(view);
  }

  function renderPretty(view, response, doc) {
    if (!response) {
      view.appendChild(Ely.view.emptyState('Send the request to see the response body.'));
      return;
    }
    if (response.truncated) {
      view.appendChild(el('div', { class: 'truncation-notice' }, `The response was larger than the display limit; showing the first ${bytes(response.body.length)}.`));
    }
    if (response.bodyKind === 'json') {
      const pretty = Ely.json.formatJson(response.body, 2);
      if (!pretty.ok) {
        view.appendChild(el('div', { class: 'truncation-notice' }, `Invalid JSON: ${pretty.error}`));
        const { node } = Ely.view.buildCodeView(response.body, { wrap: state.wrap, query: state.searchQuery });
        view.appendChild(node);
        return;
      }
      const { node, hits } = Ely.view.buildCodeView(pretty.text, { wrap: state.wrap, query: state.searchQuery });
      view.appendChild(node);
      view.dataset.hits = String(hits);
      return;
    }
    if (response.bodyKind === 'image') {
      const mime = (response.contentType || 'image/png').split(';')[0];
      view.appendChild(el('img', { class: 'preview-image', src: `data:${mime};base64,${response.body}`, alt: 'Response image' }));
      return;
    }
    if (response.bodyKind === 'binary') {
      view.appendChild(
        el(
          'div',
          { class: 'preview-empty' },
          `Binary response (${bytes(response.sizeBytes)}). Use the Raw tab to copy the base64 payload or save it from the command palette.`
        )
      );
      return;
    }
    const { node, hits } = Ely.view.buildCodeView(response.body, { wrap: state.wrap, query: state.searchQuery, highlight: response.bodyKind === 'json' });
    view.appendChild(node);
    view.dataset.hits = String(hits);
  }

  function renderRaw(view, response) {
    if (!response) return;
    const { node } = Ely.view.buildCodeView(response.body, { wrap: state.wrap, highlight: false, lineNumbers: false, query: state.searchQuery });
    view.appendChild(node);
  }

  function updateSearchCount(view) {
    const counter = $('#response-search-count');
    if (!counter) return;
    if (!state.searchQuery) {
      counter.textContent = '';
      return;
    }
    const hits = Number(view.dataset.hits || (view.querySelectorAll('mark.hit').length || 0));
    counter.textContent = hits ? `${hits} match${hits === 1 ? '' : 'es'}` : 'No matches';
  }

  /* ----------------------------- actions --------------------------------- */

  function newRequest() {
    const doc = stateApi.createDocument(
      Ely.models.normalizeRequest({ method: settings().defaultMethod, name: 'Untitled Request' }),
      { isNew: true }
    );
    state.activeId = doc.request.id;
    state.requestTab = 'params';
    lastPanelKey = null;
    renderedResponseKey = null;
    renderTabs();
    renderWorkspace();
    $('#url-input').focus();
  }

  function newRequestIn(collectionId, folderId) {
    const collection = state.snapshot.collections.find((item) => item.id === collectionId);
    const doc = stateApi.createDocument(
      Ely.models.normalizeRequest({
        method: settings().defaultMethod,
        name: 'Untitled Request',
        collectionId,
        folderId
      }),
      { isNew: true }
    );
    doc.request.collectionId = collectionId;
    doc.request.folderId = folderId;
    doc.request.name = collection ? `${collection.name} request` : 'Untitled Request';
    state.activeId = doc.request.id;
    lastPanelKey = null;
    renderedResponseKey = null;
    renderTabs();
    renderWorkspace();
  }

  function openRequest(id) {
    const existing = stateApi.findDocument(id);
    if (existing) {
      activateDocument(id);
      return;
    }
    state.selection = { type: 'request', id };
    post({ type: 'request:open', payload: { id } });
    renderTree();
  }

  function deleteRequest(request) {
    if (request.collectionId) {
      post({ type: 'request:delete', payload: { id: request.id } });
    } else {
      closeDocument(request.id);
    }
  }

  function renameRequest(request) {
    UI.promptDialog({
      title: 'Rename request',
      label: 'Request name',
      value: request.name,
      validate: (value) => (value ? null : 'The name cannot be empty.')
    }).then((name) => {
      if (!name) return;
      post({ type: 'request:set-name', payload: { id: request.id, name } });
      const doc = stateApi.findDocument(request.id);
      if (doc) {
        doc.request.name = name;
        doc.dirty = true;
        renderTabs();
        renderRequestBar(doc);
      }
    });
  }

  function moveRequestToRoot(request) {
    post({ type: 'request:save', payload: { request: Object.assign({}, request, { folderId: null }) } });
    UI.toast('Moved to the collection root', 'success');
  }

  function createCollection() {
    UI.promptDialog({ title: 'New collection', label: 'Collection name', value: 'New Collection', validate: (value) => (value ? null : 'Name required') }).then((name) => {
      if (name) post({ type: 'collection:create', payload: { name } });
    });
  }

  function renameCollection(collection) {
    UI.promptDialog({ title: 'Rename collection', label: 'Collection name', value: collection.name }).then((name) => {
      if (name) post({ type: 'collection:update', payload: { id: collection.id, patch: { name } } });
    });
  }

  /**
   * Creates a folder in the collection that owns the current selection, so the footer button needs
   * no extra picker when the user already has a collection in focus.
   */
  function createNewFolderFromFooter() {
    const collections = state.snapshot.collections || [];
    if (!collections.length) {
      createCollection();
      return;
    }
    const selection = state.selection || {};
    let collectionId = null;
    if (selection.type === 'collection') collectionId = selection.id;
    if (selection.type === 'folder') {
      const folder = state.snapshot.folders.find((candidate) => candidate.id === selection.id);
      if (folder) collectionId = folder.collectionId;
    }
    if (selection.type === 'request') {
      const request = requestById(selection.id);
      if (request && request.collectionId) collectionId = request.collectionId;
    }
    if (!collectionId) collectionId = collections[0].id;
    createFolder(collectionId, null);
  }

  function createFolder(collectionId, parentFolderId) {
    UI.promptDialog({ title: 'New folder', label: 'Folder name', value: 'New Folder' }).then((name) => {
      if (name) post({ type: 'folder:create', payload: { collectionId, parentFolderId, name } });
    });
  }

  function renameFolder(folder) {
    UI.promptDialog({ title: 'Rename folder', label: 'Folder name', value: folder.name }).then((name) => {
      if (name) post({ type: 'folder:update', payload: { id: folder.id, patch: { name } } });
    });
  }

  function createEnvironment() {
    UI.promptDialog({ title: 'New environment', label: 'Environment name', value: 'Development' }).then((name) => {
      if (name) post({ type: 'environment:create', payload: { name } });
    });
  }

  function openEnvironmentEditor(environment) {
    UI.environmentEditor(environment, (variables) => {
      post({ type: 'environment:save-variables', payload: { id: environment.id, variables } });
      UI.toast(`Saved ${variables.length} variable(s)`, 'success');
    });
  }

  function sendRequest() {
    const doc = activeDoc();
    if (!doc || doc.sending) return;
    doc.sending = true;
    doc.error = null;
    doc.tests = null;
    doc.response = null;
    renderRequestBar(doc);
    renderResponse(doc);
    post({ type: 'request:send', requestId: doc.request.id, payload: { request: doc.request } });
  }

  function cancelRequest() {
    const doc = activeDoc();
    if (!doc || !doc.sending) return;
    post({ type: 'request:cancel', requestId: doc.request.id });
  }

  function saveRequest() {
    const doc = activeDoc();
    if (!doc) return;
    const request = doc.request;
    // The host assigns a collection when a brand new request is saved without one.
    post({ type: 'request:save', requestId: request.id, payload: { request } });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => UI.toast('Copied to clipboard', 'success'),
        () => UI.toast('Clipboard is unavailable in this context', 'error')
      );
    } else {
      UI.toast('Clipboard is unavailable in this context', 'error');
    }
  }

  /* -------------------------- environment defaults ---------------------- */



  /* ------------------------- environment manager ------------------------- */

  /**
   * Persistent master-detail environment editor shown by the Environments rail.
   *
   * Edits are made on a local draft and only written when Save is pressed, so switching between
   * environments or accidentally navigating away cannot destroy unsaved work (a dirty guard warns
   * before switching). Secret values are never sent back by the host: a masked placeholder with
   * `hasValue` marks a stored secret, and leaving the field untouched keeps it.
   */
  const envEditor = {
    id: null,
    draft: null,
    dirty: false
  };

  const SECRET_MASK = '••••••••';

  function newEnvRow(seed = {}) {
    return {
      id: seed.id || `var-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      key: seed.key || '',
      value: seed.value || '',
      enabled: seed.enabled !== false,
      secret: Boolean(seed.secret),
      hasValue: Boolean(seed.hasValue)
    };
  }

  function cloneVariables(environment) {
    const rows = (environment.variables || []).map((variable) => newEnvRow(variable));
    return rows.length ? rows : [newEnvRow()];
  }

  function loadEnvironmentDraft(id, { force = false } = {}) {
    const environment = state.snapshot.environments.find((candidate) => candidate.id === id);
    if (!environment) {
      envEditor.id = null;
      envEditor.draft = null;
      envEditor.dirty = false;
      renderEnvironmentManager();
      return;
    }
    if (!force && envEditor.id === id && envEditor.draft) {
      return;
    }
    if (!force && envEditor.dirty) {
      const proceed = window.confirm('Discard unsaved variable changes?');
      if (!proceed) {
        renderEnvironmentManager();
        return;
      }
    }
    envEditor.id = id;
    envEditor.draft = cloneVariables(environment);
    envEditor.dirty = false;
    renderEnvironmentManager();
  }

  function markEnvironmentDirty() {
    envEditor.dirty = true;
    renderEnvironmentFooter();
  }

  function renderEnvironmentManager() {
    const items = $('#env-manager-items');
    if (!items) return;
    clear(items);
    const environments = state.snapshot.environments;
    const activeId = state.snapshot.activeEnvironmentId;

    if (!envEditor.id && environments.length) {
      // Open the active environment (or the first) so the editor is never empty on arrival.
      loadEnvironmentDraft(activeId || environments[0].id, { force: true });
      return;
    }

    for (const environment of environments) {
      const isSelected = environment.id === envEditor.id;
      const isActive = environment.id === activeId;
      items.appendChild(
        el(
          'button',
          {
            class: `env-manager-item ${isSelected ? 'is-selected' : ''}`,
            type: 'button',
            role: 'option',
            'aria-selected': isSelected ? 'true' : 'false',
            dataset: { id: environment.id },
            on: { click: () => loadEnvironmentDraft(environment.id) }
          },
          el('span', { class: 'env-dot', dataset: { tone: isActive ? 'active' : 'idle' }, 'aria-hidden': 'true' }),
          el('span', { class: 'env-manager-item-name' }, environment.name),
          el('span', { class: 'env-manager-item-count' }, String((environment.variables || []).length)),
          isActive ? el('span', { class: 'env-active-pill' }, 'Active') : null
        )
      );
    }

    const environment = environments.find((candidate) => candidate.id === envEditor.id);
    const nameInput = $('#env-editor-name');
    const subtitle = $('#env-editor-subtitle');
    if (nameInput) nameInput.textContent = environment ? environment.name : 'Environment';
    if (subtitle) {
      subtitle.textContent = environment
        ? `${environment.id === activeId ? 'Active environment' : 'Not active'} · ${(environment.variables || []).length} variable(s)`
        : 'Select an environment';
    }
    const rename = $('#env-editor-rename');
    if (rename) {
      rename.value = environment ? environment.name : '';
      rename.disabled = !environment;
    }
    $('#env-activate').disabled = !environment || environment.id === activeId;
    $('#env-duplicate').disabled = !environment;
    $('#env-delete').disabled = !environment;
    $('#env-add-variable').disabled = !environment;
    $('#env-editor-save').disabled = !environment || !envEditor.dirty;
    $('#env-editor-revert').disabled = !environment || !envEditor.dirty;

    if (!environment) {
      const rowsHost = $('#env-editor-rows');
      if (rowsHost) {
        clear(rowsHost);
        rowsHost.appendChild(el('div', { class: 'list-empty' }, el('p', null, 'No environment selected.'), el('p', null, 'Create one to reuse base URLs, tokens and constants.')));
      }
      renderEnvironmentFooter();
      return;
    }

    renderEnvironmentRows();
    renderEnvironmentPreview();
    renderEnvironmentFooter();
  }

  function renderEnvironmentRows() {
    const host = $('#env-editor-rows');
    if (!host || !envEditor.draft) return;
    clear(host);
    const rows = envEditor.draft;
    const count = $('#env-editor-count');
    if (count) count.textContent = String(rows.filter((row) => row.key.trim()).length);

    rows.forEach((row, index) => {
      const isStoredSecret = row.secret && row.hasValue && !row.value;
      const valueInput = el('input', {
        class: 'env-value-input',
        type: row.secret ? 'password' : 'text',
        value: isStoredSecret ? '' : row.value,
        placeholder: isStoredSecret ? `${SECRET_MASK} stored securely` : '',
        spellcheck: false,
        'aria-label': `Value for ${row.key || 'variable'}`,
        on: {
          input: (event) => {
            row.value = event.target.value;
            row.hasValue = false;
            markEnvironmentDirty();
            renderEnvironmentPreview();
          }
        }
      });
      if (isStoredSecret && row.value) {
        valueInput.placeholder = `${SECRET_MASK} stored securely`;
      }
      host.appendChild(
        el(
          'div',
          { class: 'env-editor-row' },
          el('input', {
            class: 'checkbox',
            type: 'checkbox',
            checked: row.enabled,
            'aria-label': 'Include this variable',
            on: {
              change: (event) => {
                row.enabled = event.target.checked;
                markEnvironmentDirty();
                renderEnvironmentPreview();
              }
            }
          }),
          el('input', {
            class: 'env-key-input',
            type: 'text',
            value: row.key,
            placeholder: 'variableName',
            spellcheck: false,
            'aria-label': 'Variable name',
            on: {
              input: (event) => {
                row.key = event.target.value;
                markEnvironmentDirty();
                renderEnvironmentPreview();
              }
            }
          }),
          valueInput,
          el(
            'button',
            {
              class: `env-secret-button ${row.secret ? 'is-on' : ''}`,
              type: 'button',
              title: row.secret ? 'Stored in the OS keychain — click to make plain' : 'Click to store in the OS keychain',
              'aria-pressed': row.secret ? 'true' : 'false',
              on: {
                click: () => {
                  row.secret = !row.secret;
                  markEnvironmentDirty();
                  renderEnvironmentRows();
                }
              }
            },
            row.secret ? 'secret' : 'plain'
          ),
          el(
            'button',
            {
              class: 'row-remove',
              type: 'button',
              title: 'Remove variable',
              'aria-label': 'Remove variable',
              on: {
                click: () => {
                  if (row.id && row.secret && row.hasValue) {
                    post({ type: 'environment:clear-secret', payload: { environmentId: envEditor.id, variableId: row.id } });
                  }
                  rows.splice(index, 1);
                  if (!rows.length) rows.push(newEnvRow());
                  envEditor.dirty = true;
                  renderEnvironmentRows();
                  renderEnvironmentPreview();
                  renderEnvironmentFooter();
                }
              }
            },
            '✕'
          )
        )
      );
    });
  }

  function renderEnvironmentPreview() {
    const host = $('#env-editor-preview');
    if (!host) return;
    clear(host);
    const rows = (envEditor.draft || []).filter((row) => row.enabled && row.key.trim());
    host.appendChild(el('span', { class: 'env-aside-label' }, 'Preview'));
    if (!rows.length) {
      host.appendChild(el('p', { class: 'env-aside-hint' }, 'Add a variable to preview it.'));
      return;
    }
    const list = el('div', { class: 'env-preview-list' });
    for (const row of rows.slice(0, 6)) {
      list.appendChild(
        el(
          'div',
          { class: 'env-preview-row' },
          el('code', null, `{{${row.key}}}`),
          el('span', { class: 'env-preview-value' }, row.secret ? SECRET_MASK : row.value || '(empty)')
        )
      );
    }
    host.appendChild(list);
  }

  function renderEnvironmentFooter() {
    const status = $('#env-editor-status');
    if (status) {
      status.textContent = envEditor.dirty ? 'Unsaved changes' : envEditor.id ? 'All changes saved' : '';
      status.classList.toggle('is-dirty', envEditor.dirty);
    }
    const save = $('#env-editor-save');
    if (save) save.disabled = !envEditor.id || !envEditor.dirty;
    const revert = $('#env-editor-revert');
    if (revert) revert.disabled = !envEditor.id || !envEditor.dirty;
  }

  function saveEnvironmentDraft() {
    if (!envEditor.id || !envEditor.draft) return;
    const variables = envEditor.draft
      .filter((row) => row.key.trim())
      .map((row) => ({
        id: row.id,
        key: row.key.trim(),
        value: row.value,
        enabled: row.enabled,
        secret: row.secret,
        hasValue: row.hasValue && row.secret
      }));
    post({ type: 'environment:save-variables', payload: { id: envEditor.id, variables } });
    envEditor.dirty = false;
    renderEnvironmentFooter();
    UI.toast(`Saved ${variables.length} variable(s)`, 'success');
  }

  function bindEnvironmentManager() {
    const on = (selector, handler) => {
      const node = $(selector);
      if (node) node.addEventListener('click', handler);
    };
    on('#env-new', () => post({ type: 'environment:create', payload: { name: `Environment ${state.snapshot.environments.length + 1}` } }));
    on('#env-add-variable', () => {
      if (!envEditor.draft) return;
      envEditor.draft.push(newEnvRow());
      envEditor.dirty = true;
      renderEnvironmentRows();
      renderEnvironmentPreview();
      renderEnvironmentFooter();
    });
    on('#env-editor-save', saveEnvironmentDraft);
    on('#env-editor-revert', () => loadEnvironmentDraft(envEditor.id, { force: true }));
    on('#env-activate', () => {
      if (envEditor.id) post({ type: 'environment:set-active', payload: { id: envEditor.id } });
    });
    on('#env-duplicate', () => {
      if (envEditor.id) post({ type: 'environment:duplicate', payload: { id: envEditor.id } });
    });
    on('#env-delete', () => {
      if (envEditor.id) post({ type: 'environment:delete', payload: { id: envEditor.id } });
    });
    const rename = $('#env-editor-rename');
    if (rename) {
      rename.addEventListener('input', () => {
        envEditor.dirty = true;
        envEditor.pendingName = rename.value;
        const title = $('#env-editor-name');
        if (title) title.textContent = rename.value || 'Environment';
        renderEnvironmentFooter();
      });
      rename.addEventListener('change', () => {
        // Rename commits immediately so the list stays in sync; variables still need Save.
        if (envEditor.id && rename.value.trim()) {
          post({ type: 'environment:update', payload: { id: envEditor.id, name: rename.value.trim() } });
        }
      });
    }
  }

  /* ------------------------------- settings ------------------------------- */

  /**
   * In-app settings dialog. Values are read from the state snapshot (the host is the source of
   * truth) and written back with `settings:update`, which persists them in editor settings.
   */
  const SETTING_FIELDS = [
    {
      group: 'General',
      fields: [
        { key: 'defaultMethod', label: 'Default method', type: 'select', options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
        { key: 'timeout', label: 'Request timeout (ms)', type: 'number', min: 0, step: 500, hint: '0 disables the timeout' },
        { key: 'followRedirects', label: 'Follow redirects', type: 'boolean' },
        { key: 'maxRedirects', label: 'Maximum redirects', type: 'number', min: 0, max: 20 },
        { key: 'verifyTls', label: 'Verify TLS certificates', type: 'boolean', hint: 'Disabling is not recommended' },
        { key: 'maxDisplaySize', label: 'Max response size shown (bytes)', type: 'number', min: 1024, step: 1024 }
      ]
    },
    {
      group: 'Appearance',
      fields: [
        { key: 'theme', label: 'Theme', type: 'select', options: ['auto', 'light', 'dark'] },
        { key: 'prettyPrint', label: 'Pretty-print JSON responses', type: 'boolean' },
        { key: 'confirmBeforeDelete', label: 'Confirm before deleting', type: 'boolean' }
      ]
    },
    {
      group: 'History & scripts',
      fields: [
        { key: 'historyEnabled', label: 'Record request history', type: 'boolean' },
        { key: 'historyLimit', label: 'History entries kept', type: 'number', min: 1, max: 5000 },
        { key: 'scriptTimeoutMs', label: 'Script timeout (ms)', type: 'number', min: 100, step: 100 },
        { key: 'allowPrivateNetwork', label: 'Allow localhost / private addresses', type: 'boolean' },
        { key: 'websocketMaxMessages', label: 'WebSocket message buffer', type: 'number', min: 10, max: 10000 }
      ]
    }
  ];

  function settingValue(key) {
    const current = settings();
    return current && current[key] !== undefined ? current[key] : undefined;
  }

  function openSettings() {
    const rows = [];
    for (const group of SETTING_FIELDS) {
      rows.push(el('h4', { class: 'settings-group-title' }, group.group));
      for (const field of group.fields) {
        const value = settingValue(field.key);
        let control;
        if (field.type === 'boolean') {
          control = el('input', { type: 'checkbox', id: `setting-${field.key}`, class: 'settings-checkbox' });
          control.checked = Boolean(value);
        } else if (field.type === 'select') {
          control = el('select', { id: `setting-${field.key}`, class: 'settings-input' });
          for (const option of field.options) {
            const optionEl = el('option', { value: option }, option);
            if (String(value) === option) optionEl.selected = true;
            control.appendChild(optionEl);
          }
        } else {
          control = el('input', {
            id: `setting-${field.key}`,
            class: 'settings-input',
            type: 'number',
            min: field.min,
            max: field.max,
            step: field.step || 1
          });
          control.value = value === undefined || value === null ? '' : String(value);
        }
        rows.push(
          el(
            'label',
            { class: 'settings-row', for: `setting-${field.key}` },
            el(
              'span',
              { class: 'settings-label' },
              el('span', { class: 'settings-name' }, field.label),
              field.hint ? el('span', { class: 'settings-hint' }, field.hint) : null
            ),
            control
          )
        );
      }
    }

    const modal = UI.openModal({
      title: 'Settings',
      wide: true,
      body: el('div', { class: 'settings-form' }, rows),
      footer: [
        el(
          'button',
          {
            class: 'button ghost',
            type: 'button',
            on: {
              click: () => {
                modal.close();
                post({ type: 'settings:open-native' });
              }
            }
          },
          'Open editor settings'
        ),
        el('div', { class: 'spacer' }),
        el('button', { class: 'button ghost', type: 'button', on: { click: () => modal.close() } }, 'Cancel'),
        el(
          'button',
          {
            class: 'button primary',
            type: 'button',
            on: {
              click: () => {
                for (const group of SETTING_FIELDS) {
                  for (const field of group.fields) {
                    const input = document.getElementById(`setting-${field.key}`);
                    if (!input) continue;
                    let next;
                    if (field.type === 'boolean') next = input.checked;
                    else if (field.type === 'number') next = Number(input.value);
                    else next = input.value;
                    const previous = settingValue(field.key);
                    if (typeof next === 'number' && Number.isNaN(next)) continue;
                    if (next !== previous) {
                      post({ type: 'settings:update', payload: { key: field.key, value: next } });
                    }
                  }
                }
                if (settingValue('theme') !== state.theme) {
                  state.theme = null;
                  applyTheme();
                }
                modal.close();
              }
            }
          },
          'Save settings'
        )
      ]
    });
  }

  function applyTheme() {
    let theme = state.theme;
    if (!theme) {
      const setting = settings().theme;
      if (setting === 'auto') {
        const vscodeKind = document.body.classList.contains('vscode-dark') ? 'dark' : document.body.classList.contains('vscode-light') ? 'light' : null;
        theme = vscodeKind || (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      } else {
        theme = setting;
      }
    }
    document.body.dataset.theme = theme;
  }

  /* ------------------------------ messaging ----------------------------- */

  function onSnapshot(payload) {
    state.snapshot = payload;
    // Update open documents that came from storage (keep local edits).
    for (const doc of state.documents) {
      if (!doc.dirty && doc.request.collectionId) {
        const stored = payload.requests.find((request) => request.id === doc.request.id);
        if (stored) {
          doc.request = Ely.models.normalizeRequest(stored);
        }
      }
    }
    renderTree();
    renderHistory();
    renderEnvironments();
    renderEnvironmentSelector();
    renderEnvPopover();
    renderTabs();
    if (!state.websocketOpen) {
      renderWorkspace();
      const doc = activeDoc();
      if (doc) {
        lastPanelKey = null;
        renderRequestPanel(doc);
        renderRequestBar(doc);
      }
    }
    renderWebSocketPanel();
    applyTheme();
    const count = $('#status-count');
    if (count) count.textContent = `${payload.collections.length} collections · ${payload.requests.length} requests`;
  }

  function onRequestOpened(payload) {
    const existing = stateApi.findDocument(payload.request.id);
    if (existing) {
      existing.hasSecret = Boolean(payload.hasSecret);
      activateDocument(payload.request.id);
      return;
    }
    const doc = stateApi.createDocument(payload.request, { hasSecret: payload.hasSecret, isNew: payload.isNew });
    state.activeId = doc.request.id;
    state.selection = { type: 'request', id: doc.request.id };
    lastPanelKey = null;
    renderedResponseKey = null;
    renderTabs();
    renderWorkspace();
    renderTree();
  }

  function onRequestFinished(message) {
    // The host posts `{ type, requestId, payload: { response | error, tests, resolved } }`.
    const payload = message.payload || {};
    const doc = stateApi.findDocument(message.requestId) || stateApi.findDocument(payload.request && payload.request.id);
    if (!doc) return;
    doc.sending = false;
    if (payload.error) {
      doc.error = payload.error;
      doc.response = null;
    } else {
      doc.response = payload.response;
      doc.error = null;
    }
    doc.tests = payload.tests;
    doc.resolved = payload.resolved;
    renderedResponseKey = null;
    if (doc.request.id === state.activeId) {
      renderRequestBar(doc);
      renderResponse(doc);
    }
  }

  function onToast(message) {
    UI.toast(message.payload.message, message.payload.level || 'info');
    if (message.payload.warnings && message.payload.warnings.length) {
      setTimeout(() => UI.toast(`${message.payload.warnings.length} import warning(s): ${message.payload.warnings[0]}`, 'warning', 6000), 400);
    }
  }

  function registerMessages() {
    Ely.transport.onMessage((message) => {
      switch (message.type) {
        case 'state:snapshot':
          onSnapshot(message.payload);
          break;
        case 'request:opened':
          onRequestOpened(message.payload);
          break;
        case 'request:started': {
          const doc = stateApi.findDocument(message.requestId);
          if (doc) {
            doc.sending = true;
            renderRequestBar(doc);
            renderResponse(doc);
          }
          break;
        }
        case 'request:finished':
          onRequestFinished(message);
          break;
        case 'request:cancelled': {
          const doc = stateApi.findDocument(message.requestId);
          if (doc) {
            doc.sending = false;
            doc.error = { kind: 'cancelled', message: 'The request was cancelled.' };
            renderRequestBar(doc);
            renderResponse(doc);
          }
          break;
        }
        case 'request:saved': {
          const doc = stateApi.findDocument(message.payload.request.id) || findDraftDocument(message.payload.request);
          if (doc) {
            const previousId = doc.request.id;
            doc.request = Ely.models.normalizeRequest(message.payload.request);
            doc.dirty = false;
            doc.isNew = false;
            if (previousId !== doc.request.id) {
              // The saved request id may differ from the placeholder draft id: keep the tab active.
              if (state.activeId === previousId) state.activeId = doc.request.id;
              if (state.selection.id === previousId) state.selection = { type: 'request', id: doc.request.id };
            }
            renderTabs();
          }
          UI.toast('Request saved', 'success');
          break;
        }
        case 'request:auth-updated': {
          const doc = stateApi.findDocument(message.payload.requestId);
          if (doc) {
            doc.request.auth = Ely.models.normalizeAuth(message.payload.auth);
            doc.hasSecret = true;
          }
          break;
        }
        case 'request:rename': {
          const doc = stateApi.findDocument(message.payload.id);
          if (doc) {
            doc.request.name = message.payload.name;
            doc.dirty = true;
            renderTabs();
            renderRequestBar(doc);
          }
          break;
        }
        case 'request:close':
          closeDocument(message.payload.id);
          break;
        case 'environment:open-editor': {
          const environment = state.snapshot.environments.find((env) => env.id === message.payload.id);
          if (environment) openEnvironmentEditor(environment);
          break;
        }
        case 'websocket:open-workspace':
          openWebSocketWorkspace();
          break;
        case 'command:send':
          sendRequest();
          break;
        case 'command:save':
          saveRequest();
          break;
        case 'auth:secret-state': {
          const doc = stateApi.findDocument(message.payload.requestId);
          if (doc) doc.hasSecret = Boolean(message.payload.hasSecret);
          break;
        }
        case 'run:progress':
          // Progress is only meaningful for the run the user started in this session.
          if (state.runnerOpen) {
            state.run = message.payload.run;
            renderRunnerWorkspace();
          }
          break;
        case 'run:finished':
          if (state.runnerOpen) {
            if (message.payload.error) {
              state.run = null;
              renderRunnerWorkspace();
              UI.toast(message.payload.error.message || 'The run failed to start.', 'error');
            } else {
              state.run = message.payload.run;
              renderRunnerWorkspace();
              const run = state.run;
              UI.toast(
                run.failedRequests + run.erroredRequests === 0
                  ? `Run passed — ${run.passedTests} test(s) in ${duration(run.durationMs)}.`
                  : `Run failed — ${run.failedTests} failing test(s), ${run.erroredRequests} request error(s).`,
                run.failedRequests + run.erroredRequests === 0 ? 'success' : 'error'
              );
            }
          }
          break;
        case 'run:cancelled':
          if (state.run) {
            state.run = { ...state.run, status: 'cancelled', cancelled: true, finishedAt: Date.now() };
            renderRunnerWorkspace();
          }
          break;
        case 'websocket:update':
          state.snapshot.tools = { websocket: message.payload.session };
          renderWebSocketPanel();
          break;
        case 'toast':
          onToast(message);
          break;
        case 'harness:ready':
          // The harness host is attached; ask for the initial snapshot explicitly in case the
          // earlier ready message was sent before the host finished booting.
          post({ type: 'webview:ready' });
          break;
        case 'error':
          UI.toast(`${message.payload.title}: ${message.payload.message}`, 'error', 6000);
          break;
        case 'history:results':
          break;
        default:
          break;
      }
    });
  }

  function findDraftDocument(request) {
    return state.documents.find((doc) => doc.request.id === request.id || (doc.isNew && doc.request.collectionId === request.collectionId && doc.request.url === request.url));
  }

  /* ------------------------------ websocket UI --------------------------- */

  function renderWebSocketPanel() {
    const session = state.snapshot.tools.websocket;
    const status = $('#ws-status');
    const label = $('#ws-status-label');
    const connectButton = $('#ws-connect');
    const disconnectButton = $('#ws-disconnect');
    const compact = $('#ws-compact');
    if (compact) {
      clear(compact);
      compact.appendChild(
        el(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' } },
          el('span', { class: 'status-dot-mini', dataset: { tone: session && session.state === 'open' ? 'success' : session && session.state === 'error' ? 'error' : 'muted' } }),
          el('span', null, session ? `${session.state} · ${session.messages.length} messages` : 'Not connected')
        )
      );
    }
    if (status) {
      status.dataset.state = session ? session.state : 'idle';
      label.textContent = session ? `${session.state}` : 'Disconnected';
    }
    if (connectButton) connectButton.hidden = Boolean(session && ['open', 'connecting'].includes(session.state));
    if (disconnectButton) disconnectButton.hidden = !(session && ['open', 'connecting'].includes(session.state));
    const log = $('#ws-log');
    if (!log) return;
    clear(log);
    if (!session || !session.messages.length) {
      log.appendChild(
        el('div', { class: 'ws-log-empty' }, session ? 'Connected. Messages will appear here.' : 'Enter a WebSocket URL (ws:// or wss://) and connect to start streaming messages.')
      );
      return;
    }
    for (const message of session.messages) {
      log.appendChild(
        el(
          'div',
          { class: 'ws-message-row', dataset: { direction: message.direction } },
          el('span', { class: 'ws-dir' }, message.direction === 'in' ? 'IN' : message.direction === 'out' ? 'OUT' : 'SYS'),
          el('span', { class: 'ws-time' }, clock(message.timestamp)),
          el('span', { class: 'ws-data' }, message.data)
        )
      );
    }
    log.scrollTop = log.scrollHeight;
  }

  /* -------------------------------- wiring ------------------------------- */

  function bindTabs() {
    for (const button of $$('.request-workspace .tab-item[data-tab]')) {
      button.addEventListener('click', () => {
        state.requestTab = button.dataset.tab;
        lastPanelKey = null;
        renderRequestTabs(activeDoc());
        renderRequestPanel(activeDoc());
      });
    }
    for (const button of $$('.response-tabs .tab-item[data-rtab]')) {
      button.addEventListener('click', () => {
        state.responseTab = button.dataset.rtab;
        renderedResponseKey = null;
        renderResponseTabs(activeDoc());
        renderResponseView(activeDoc());
      });
    }
    for (const button of $$('.sidebar-tab')) {
      button.addEventListener('click', () => selectSection(button.dataset.section));
    }
  }

  /**
   * Activates a sidebar section and the workspace it owns. Every section change re-renders the main
   * pane so leaving the environment manager can never leave it on screen.
   */
  function selectSection(section) {
    state.section = section;
    Ely.store.set({ section });
    for (const tab of $$('.sidebar-tab')) {
      const isActive = tab.dataset.section === section;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
    for (const panel of $$('.sidebar-panel')) {
      panel.hidden = panel.dataset.panel !== section;
    }
    // In manager mode the explorer collapses to an icon rail (see `body.manager-mode`), so the
    // grid track order must stay sidebar-then-main.
    document.body.classList.toggle('manager-mode', section === 'environments');
    renderWorkspace();
    if (section === 'websocket') {
      openWebSocketWorkspace();
    } else if (state.websocketOpen) {
      // Switching to any other sidebar section must leave the WebSocket workspace, otherwise its
      // UI stays on screen and the request editor is unreachable.
      closeWebSocketWorkspace();
    }
  }

  function openWebSocketWorkspace() {
    state.websocketOpen = true;
    renderWorkspace();
    renderWebSocketPanel();
    $('#ws-url').focus();
  }

  function closeWebSocketWorkspace() {
    state.websocketOpen = false;
    renderTabs();
    renderWorkspace();
  }

  /* --------------------------- collection runner -------------------------- */

  function openRunner(collectionId, folderId) {
    const collections = state.snapshot.collections;
    const target =
      collections.find((collection) => collection.id === collectionId) ||
      collections.find((collection) => collection.id === state.runnerCollectionId) ||
      collections[0];
    if (!target) {
      UI.toast('Create a collection first.', 'warning');
      return;
    }
    state.runnerCollectionId = target.id;
    state.runnerFolderId = folderId || null;
    Ely.store.set({ runnerCollectionId: target.id });
    state.runnerOpen = true;
    state.websocketOpen = false;
    state.run = null;
    state.runnerOpenRows = [];
    renderTabs();
    renderWorkspace();
  }

  function closeRunner() {
    state.runnerOpen = false;
    renderTabs();
    renderWorkspace();
  }

  function startRun() {
    if (!state.runnerCollectionId) {
      openRunner(null);
      return;
    }
    state.run = {
      runId: `local-${Date.now().toString(36)}`,
      status: 'running',
      cancelled: false,
      startedAt: Date.now(),
      durationMs: 0,
      totalRequests: 0,
      passedRequests: 0,
      failedRequests: 0,
      erroredRequests: 0,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      items: []
    };
    state.runnerOpenRows = [];
    renderRunnerWorkspace();
    post({
      type: 'run:start',
      payload: { collectionId: state.runnerCollectionId, folderId: state.runnerFolderId || undefined }
    });
  }

  function stopRun() {
    if (state.run && state.run.status === 'running') {
      post({ type: 'run:cancel', payload: { runId: state.run.runId } });
    }
  }

  function runnerStatusLabel(status) {
    return (
      { idle: 'Idle', running: 'Running', passed: 'Passed', failed: 'Failed', cancelled: 'Cancelled' }[status] || 'Idle'
    );
  }

  function renderRunnerWorkspace() {
    const collection = state.snapshot.collections.find((candidate) => candidate.id === state.runnerCollectionId);
    const folder = state.runnerFolderId
      ? state.snapshot.folders.find((candidate) => candidate.id === state.runnerFolderId)
      : null;
    const run = state.run;
    const status = run ? run.status : 'idle';

    $('#runner-title').textContent = folder
      ? `Run: ${collection ? collection.name : 'Collection'} / ${folder.name}`
      : collection
        ? `Run: ${collection.name}`
        : 'Collection runner';
    $('#runner-subtitle').textContent = run
      ? run.status === 'running'
        ? 'Executing requests in tree order…'
        : `Finished ${run.items.length} of ${run.totalRequests || run.items.length} request(s).`
      : 'Run every request in a collection and see the aggregate result.';
    const pill = $('#runner-status-pill');
    pill.textContent = runnerStatusLabel(status);
    pill.dataset.status = status;

    const running = status === 'running';
    $('#runner-run').hidden = running;
    $('#runner-run').textContent = run && run.items.length ? 'Run again' : 'Run collection';
    $('#runner-stop').hidden = !running;

    const summary = $('#runner-summary');
    summary.hidden = !run;
    if (run) {
      $('#runner-stat-tests').textContent = `${run.passedTests}/${run.passedTests + run.failedTests}`;
      $('#runner-stat-passed').textContent = String(run.passedRequests);
      $('#runner-stat-failed').textContent = String(run.failedRequests + run.erroredRequests);
      $('#runner-stat-duration').textContent = duration(run.durationMs || 0);
      const total = run.totalRequests || run.items.length || 0;
      const pct = total ? Math.round((run.items.length / total) * 100) : running ? 4 : 0;
      const bar = $('.runner-progress');
      $('#runner-progress-fill').style.width = `${running ? Math.max(4, pct) : 100}%`;
      if (bar) bar.setAttribute('aria-valuenow', String(pct));
    }
    renderRunnerResults(run);
  }

  function renderRunnerResults(run) {
    const root = $('#runner-results');
    if (!root) return;
    clear(root);
    if (!run || !run.items.length) {
      root.appendChild(
        el(
          'div',
          { class: 'runner-empty', id: 'runner-empty' },
          el('p', null, run && run.status === 'running' ? 'Waiting for the first request…' : 'Pick a collection in the sidebar, then start a run.'),
          el('p', { class: 'runner-hint' }, 'Every request is executed in tree order and its test assertions are collected into one report.')
        )
      );
      return;
    }
    for (const item of run.items) {
      const failed = (item.tests?.failed ?? 0) > 0 || !!item.error;
      const tone = item.error ? 'error' : failed ? 'fail' : 'pass';
      const open = state.runnerOpenRows.includes(item.requestId);
      const statusLabel = item.error ? 'Error' : item.status ? `${item.status} ${item.statusText || ''}`.trim() : '—';
      const row = el('div', { class: `runner-row ${open ? 'is-open' : ''}`, role: 'listitem' });
      const head = el(
        'div',
        {
          class: 'runner-row-head',
          on: {
            click: () => {
              const index = state.runnerOpenRows.indexOf(item.requestId);
              if (index === -1) state.runnerOpenRows.push(item.requestId);
              else state.runnerOpenRows.splice(index, 1);
              renderRunnerResults(state.run);
            }
          }
        },
        el(
          'svg',
          { class: 'runner-caret', viewBox: '0 0 12 12', 'aria-hidden': 'true' },
          el('path', { d: 'M4 2.5 8 6l-4 3.5', stroke: 'currentColor', 'stroke-width': '1.6', fill: 'none', 'stroke-linecap': 'round' })
        ),
        el('span', { class: 'runner-method' }, item.method),
        el(
          'span',
          { class: 'runner-row-name' },
          item.name,
          el('span', { class: 'runner-row-url' }, shortUrl(item.url))
        ),
        el('span', { class: 'runner-row-status', dataset: { tone } }, `${tone === 'pass' ? '✓' : tone === 'fail' ? '✕' : '!'} ${statusLabel}`),
        el('span', { class: 'runner-row-duration' }, duration(item.durationMs || 0))
      );
      row.appendChild(head);
      if (open) {
        const body = el('div', { class: 'runner-row-body' });
        const results = item.tests?.results || [];
        if (item.error) {
          body.appendChild(el('div', { class: 'runner-row-error' }, `Request failed: ${item.error.message}`));
        }
        if (item.tests?.error) {
          body.appendChild(el('div', { class: 'runner-row-error' }, item.tests.error));
        }
        if (results.length) {
          for (const result of results) {
            body.appendChild(
              el(
                'div',
                { class: `runner-test ${result.passed ? 'is-pass' : 'is-fail'}` },
                el('span', { class: 'runner-test-mark' }, result.passed ? '✓' : '✕'),
                el('span', null, result.name),
                result.message ? el('span', { class: 'runner-test-message' }, result.message) : null
              )
            );
          }
        } else if (!item.error && !item.tests?.error) {
          body.appendChild(el('div', { class: 'runner-row-none' }, 'No test scripts on this request.'));
        }
        row.appendChild(body);
      }
      root.appendChild(row);
    }
  }

  function bindUrlBar() {
    const urlInput = $('#url-input');
    urlInput.addEventListener('input', () => {
      const doc = activeDoc();
      if (!doc) return;
      doc.request.url = urlInput.value;
      stateApi.markDirty(doc);
      renderRequestBar(doc);
      const preview = $('.request-panel[data-panel="params"] .panel-hint[style]');
      if (preview) preview.textContent = buildPreviewUrl(doc.request);
    });
    urlInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        sendRequest();
      }
    });
    const nameInput = $('#request-name');
    nameInput.addEventListener('input', () => {
      const doc = activeDoc();
      if (!doc) return;
      doc.request.name = nameInput.value;
      doc.dirty = true;
      renderTabs();
    });
    $('#method-select').addEventListener('click', () => {
      const anchor = $('#method-select');
      UI.showMenu(anchor, [
        { label: 'HTTP method', heading: true },
        ...Ely.HTTP_METHODS.map((method) => ({
          label: method,
          hint: method === activeDoc().request.method ? '✓' : '',
          onSelect: () => {
            const doc = activeDoc();
            doc.request.method = method;
            stateApi.markDirty(doc);
            renderRequestBar(doc);
            renderTabs();
            renderTree();
          }
        }))
      ], { className: 'menu context-menu' });
    });
    $('#btn-send').addEventListener('click', sendRequest);
    $('#btn-cancel').addEventListener('click', cancelRequest);
    $('#btn-save').addEventListener('click', saveRequest);
    $('#request-more').addEventListener('click', () => {
      const doc = activeDoc();
      if (!doc) return;
      UI.showMenu($('#request-more'), [
        { label: 'Duplicate request', onSelect: () => post({ type: 'request:duplicate', payload: { id: doc.request.id } }) },
        { label: 'Copy as cURL', onSelect: () => post({ type: 'export:request-curl', payload: { request: doc.request } }) },
        { label: 'Copy URL', onSelect: () => copyText(doc.request.url) },
        { separator: true },
        { label: 'Close tab', onSelect: () => closeDocument(doc.request.id) },
        { label: 'Delete request', danger: true, onSelect: () => post({ type: 'request:delete', payload: { id: doc.request.id } }) }
      ], { alignRight: true });
    });
  }

  function bindTopbar() {
    $('#btn-new-collection').addEventListener('click', createCollection);
    $('#btn-new-collection-footer').addEventListener('click', createCollection);
    $('#btn-new-folder-footer').addEventListener('click', createNewFolderFromFooter);
    $('#btn-new-environment').addEventListener('click', createEnvironment);
    $('#btn-import').addEventListener('click', () => {
      UI.showMenu($('#btn-import'), [
        { label: 'Import from file…', onSelect: () => post({ type: 'import:run', payload: { format: 'auto' } }) },
        { label: 'Import Postman collection…', onSelect: () => post({ type: 'import:run', payload: { format: 'postman' } }) },
        { label: 'Import OpenAPI document…', onSelect: () => post({ type: 'import:run', payload: { format: 'openapi' } }) }
      ], { alignRight: true });
    });
    $('#btn-settings').addEventListener('click', () => openSettings());
    $('#runner-run').addEventListener('click', startRun);
    $('#runner-stop').addEventListener('click', stopRun);
    $('#runner-close').addEventListener('click', closeRunner);
    bindEnvironmentManager();
    $('#btn-theme').addEventListener('click', () => {
      const current = document.body.dataset.theme;
      state.theme = current === 'dark' ? 'light' : 'dark';
      Ely.store.set({ theme: state.theme });
      applyTheme();
    });
    const selector = $('#env-selector');
    selector.addEventListener('click', (event) => {
      event.stopPropagation();
      const popover = $('#env-popover');
      popover.hidden = !popover.hidden;
      renderEnvPopover();
    });
    document.addEventListener('click', (event) => {
      const popover = $('#env-popover');
      if (popover && !popover.hidden && !popover.contains(event.target) && !selector.contains(event.target)) {
        popover.hidden = true;
      }
    });
    $('#welcome-new').addEventListener('click', newRequest);
    $('#welcome-import').addEventListener('click', () => post({ type: 'import:run', payload: { format: 'auto' } }));
    $('#welcome-ws').addEventListener('click', openWebSocketWorkspace);
    $('#btn-open-ws').addEventListener('click', openWebSocketWorkspace);
    $('#ws-back').addEventListener('click', closeWebSocketWorkspace);
    $('#btn-clear-history').addEventListener('click', async () => {
      if (settings().confirmBeforeDelete) {
        const confirmed = await UI.confirmDialog({ title: 'Clear history', message: 'Remove every history entry? Requests that are saved in collections are not affected.', confirmLabel: 'Clear history' });
        if (!confirmed) return;
      }
      post({ type: 'history:clear' });
    });
    $('#collection-search').addEventListener('input', (event) => {
      state.collectionFilter = event.target.value;
      renderTree();
    });
    $('#history-search').addEventListener('input', (event) => {
      state.historyFilter = event.target.value;
      renderHistory();
    });
    const clearHistoryShortcut = (event) => {
      if (event.target === $('#collection-search') || event.target === $('#history-search')) {
        if (event.key === 'Escape') {
          event.target.value = '';
          event.target.dispatchEvent(new Event('input'));
        }
      }
    };
    document.addEventListener('keydown', clearHistoryShortcut);
  }

  function bindResponseActions() {
    $('#btn-copy-response').addEventListener('click', () => {
      const doc = activeDoc();
      if (!doc || !doc.response) return;
      copyText(doc.response.body);
    });
    $('#btn-export-curl').addEventListener('click', () => {
      const doc = activeDoc();
      if (doc) post({ type: 'export:request-curl', payload: { request: doc.request } });
    });
    $('#btn-wrap').addEventListener('click', () => {
      state.wrap = !state.wrap;
      Ely.store.set({ wrap: state.wrap });
      $('#btn-wrap').classList.toggle('is-on', state.wrap);
      renderedResponseKey = null;
      renderResponseView(activeDoc());
    });
    $('#btn-wrap').classList.toggle('is-on', state.wrap);
    const searchBar = $('#response-search');
    const searchInput = $('#response-search-input');
    $('#btn-search-response').addEventListener('click', () => {
      searchBar.hidden = !searchBar.hidden;
      if (!searchBar.hidden) searchInput.focus();
      else {
        state.searchQuery = '';
        renderedResponseKey = null;
        renderResponseView(activeDoc());
      }
    });
    searchInput.addEventListener('input', Ely.util.debounce(() => {
      state.searchQuery = searchInput.value.trim();
      renderedResponseKey = null;
      renderResponseView(activeDoc());
      const view = $(`.response-view[data-rview="${state.responseTab}"]`);
      if (view) updateSearchCount(view);
      const first = document.querySelector('mark.hit');
      if (first) first.scrollIntoView({ block: 'center' });
    }, 200));
    $('#response-search-close').addEventListener('click', () => {
      searchBar.hidden = true;
      state.searchQuery = '';
      renderedResponseKey = null;
      renderResponseView(activeDoc());
    });
  }

  function bindSplitter() {
    const splitter = $('#splitter');
    const workspaceEl = $('#request-workspace');
    const responseEl = $('#response-workspace');
    let dragging = false;
    const apply = (ratio) => {
      state.splitRatio = Ely.util.clamp(ratio, 0.25, 0.75);
      // Rows: bar, name, tabs, panels | splitter, response. Only the last two are proportional so
      // the chrome keeps its natural height and the splitter maps 1:1 to the pointer position.
      const panels = Math.round((1 - state.splitRatio) * 100);
      const response = Math.round(state.splitRatio * 100);
      workspaceEl.style.gridTemplateRows = `auto auto auto minmax(0, ${panels}fr) 5px minmax(180px, ${response}fr)`;
    };
    const saved = Ely.store.get('sessionSplit', null);
    if (saved) apply(saved);
    const onMove = (event) => {
      if (!dragging) return;
      const rect = workspaceEl.getBoundingClientRect();
      const y = (event.touches ? event.touches[0].clientY : event.clientY) - rect.top;
      apply(y / rect.height);
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      Ely.store.set({ sessionSplit: state.splitRatio });
      document.body.style.cursor = '';
    };
    splitter.addEventListener('mousedown', () => {
      dragging = true;
      document.body.style.cursor = 'row-resize';
    });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
    splitter.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowUp') apply(state.splitRatio - 0.04);
      if (event.key === 'ArrowDown') apply(state.splitRatio + 0.04);
    });
    let touchDragging = false;
    splitter.addEventListener('touchstart', () => {
      touchDragging = true;
      onMove({ touches: [] });
    }, { passive: true });
    window.addEventListener('touchmove', (event) => {
      if (touchDragging) onMove(event);
    }, { passive: true });
    window.addEventListener('touchend', () => {
      if (touchDragging) {
        touchDragging = false;
        Ely.store.set({ sessionSplit: state.splitRatio });
      }
    });
  }

  function bindWebSocket() {
    $('#ws-connect').addEventListener('click', () => {
      const url = $('#ws-url').value.trim();
      if (!url) {
        UI.toast('Enter a WebSocket URL first.', 'warning');
        return;
      }
      post({ type: 'websocket:connect', payload: { url, headers: [] } });
    });
    $('#ws-disconnect').addEventListener('click', () => post({ type: 'websocket:disconnect' }));
    $('#ws-clear').addEventListener('click', () => post({ type: 'websocket:clear' }));
    $('#ws-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = $('#ws-message');
      const text = input.value;
      if (!text) return;
      post({ type: 'websocket:send', payload: { message: text } });
      input.value = '';
    });
    $('#ws-message').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('#ws-form').dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (event) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      const meta = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape' && activeDoc() && activeDoc().sending) {
        event.preventDefault();
        cancelRequest();
        return;
      }
      if (meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveRequest();
        return;
      }
      if (meta && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        $('#btn-search-response').click();
        return;
      }
      if (meta && event.key === 'Enter') {
        event.preventDefault();
        sendRequest();
        return;
      }
      if (event.ctrlKey && event.altKey && event.key === 'Enter') {
        event.preventDefault();
        sendRequest();
        return;
      }
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'v') {
        event.preventDefault();
        const popover = $('#env-popover');
        popover.hidden = !popover.hidden;
        renderEnvPopover();
        return;
      }
      if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        $('#btn-theme').click();
        return;
      }
      if (event.key === '/' && !inField) {
        event.preventDefault();
        $('#collection-search').focus();
        return;
      }
      if (meta && event.key.toLowerCase() === 'w' && !inField) {
        // do not hijack the editor's close-tab shortcut
      }
    });
  }

  /* ------------------------------- bootstrap ----------------------------- */

  function bootstrap() {
    Ely.transport.detectMode();
    Ely.transport.startHarnessPolling();
    bindTabs();
    bindUrlBar();
    bindTopbar();
    bindResponseActions();
    bindSplitter();
    bindWebSocket();
    bindShortcuts();
    registerMessages();
    applyTheme();
    for (const panel of $$('.sidebar-panel')) {
      panel.hidden = panel.dataset.panel !== state.section;
    }
    for (const tab of $$('.sidebar-tab')) {
      tab.classList.toggle('is-active', tab.dataset.section === state.section);
    }
    renderTabs();
    renderWorkspace();
    post({ type: 'webview:ready' });
    if (Ely.transport.isHarness()) {
      document.body.dataset.harness = 'true';
    }
    window.addEventListener('resize', Ely.util.debounce(() => {
      renderedResponseKey = null;
    }, 250));
  }

  window.ElyApp = { bootstrap, newRequest, sendRequest, saveRequest, openRequest, state };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();

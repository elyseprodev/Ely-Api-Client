import type {
  ApiEnvironment,
  ApiRequest,
  AppSnapshot,
  HttpErrorDetails,
  KeyValueRow,
  SendRequestResult,
  WebSocketSessionInfo
} from '../models/types';
import { SecurityError, validateMessage, validateName } from '../security/SecurityValidator';
import { redactSecrets } from '../security/Sanitizer';
import { StorageManager } from '../storage/StorageManager';
import { SecretService } from '../security/SecretStorage';
import { HttpClient } from './HttpClient';
import { AuthService } from './AuthService';
import { CollectionService } from './CollectionService';
import { EnvironmentService } from './EnvironmentService';
import { HistoryService } from './HistoryService';
import { WebSocketService } from './WebSocketService';
import { RequestExecutionService } from './RequestExecutionService';
import { CollectionRunner, RunAbortedError } from './CollectionRunner';
import { ImportExportService } from './ImportExportService';
import { toWebviewSettings, type ExtensionSettings } from './SettingsService';
import { ScriptRunner } from '../scripting/ScriptRunner';
import { createRequest } from '../models/Request';
import type { EmitterLike } from '../models/Emitter';

/**
 * Framework-independent core of the ElyApiClient client.
 *
 * It owns the services (collections, environments, history, HTTP, scripts, WebSocket) and the
 * message protocol spoken by the webview. It depends on no VS Code API, so:
 *  - `ExtensionController` (in the editor) subclasses it to add dialogs, file pickers and settings,
 *  - the UI harness and integration tests instantiate it directly in plain Node.
 *
 * Every message is validated before dispatch; every mutation flows through a service so both UIs
 * stay in sync.
 */

export interface ClientTransport {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): { dispose(): void };
}

export interface HostAdapter {
  openFiles(options: { canSelectMany: boolean; openLabel?: string; filters?: Record<string, string[]> }): Promise<string[]>;
  saveFile(options: { defaultName: string; filters?: Record<string, string[]> }): Promise<string | null>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: Uint8Array): Promise<void>;
  confirm(message: string, confirmLabel: string): Promise<boolean>;
  notify(message: string, level?: 'info' | 'warning' | 'error'): Promise<void>;
  openSettings(): Promise<void>;
  openExternal(url: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  updateSetting(key: string, value: string | number | boolean): Promise<void>;
  isWorkspaceTrusted(): boolean;
  /** Called before a file is read for a request body (workspace trust enforcement). */
  assertFileAccessAllowed(): void;
  workspaceRoot?(): string | null;
}

/** A host used by the headless harness/tests: no UI, files in memory. */
export class HeadlessHostAdapter implements HostAdapter {
  readonly files = new Map<string, Uint8Array>();
  readonly notifications: { message: string; level: string }[] = [];
  readonly clipboard: string[] = [];
  private pendingOpen: string[] = [];
  trusted = true;

  queueOpenFile(path: string): void {
    this.pendingOpen.push(path);
  }

  async openFiles(): Promise<string[]> {
    return this.pendingOpen.splice(0);
  }

  async saveFile(options: { defaultName: string }): Promise<string | null> {
    return options.defaultName;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (!content) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    this.files.set(path, content);
  }

  async confirm(): Promise<boolean> {
    return true;
  }

  async notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
    this.notifications.push({ message, level });
  }

  async openSettings(): Promise<void> {
    this.notifications.push({ message: 'openSettings', level: 'info' });
  }

  async openExternal(): Promise<void> {
    /* no-op in headless mode */
  }

  async copyToClipboard(text: string): Promise<void> {
    this.clipboard.push(text);
  }

  async updateSetting(): Promise<void> {
    /* settings are supplied by the embedder */
  }

  isWorkspaceTrusted(): boolean {
    return this.trusted;
  }

  assertFileAccessAllowed(): void {
    if (!this.trusted) {
      throw new SecurityError('Reading files is disabled in Restricted Mode. Trust the workspace to send file bodies.', 'blocked');
    }
  }

  /** Set by the harness so ${workspaceFolder}/… body paths resolve like a real workspace. */
  workspaceRoot(): string | null {
    return this.root;
  }

  root: string | null = null;
}

const MASK = '••••••••';

export class AppCore {
  protected readonly http = new HttpClient();
  readonly secrets: SecretService;
  protected readonly auth: AuthService;
  protected readonly storage: StorageManager;
  protected readonly scriptRunner: ScriptRunner;
  protected readonly execution: RequestExecutionService;
  protected readonly runner: CollectionRunner;
  protected readonly importExport = new ImportExportService();

  readonly collections: CollectionService;
  readonly environments: EnvironmentService;
  readonly history: HistoryService;
  readonly websockets: WebSocketService;

  protected transport: ClientTransport | undefined;
  protected readonly pendingRequests = new Map<string, { controller: AbortController; startedAt: number }>();
  protected readonly pendingRuns = new Map<string, { controller: AbortController; startedAt: number }>();
  protected readonly openDocuments = new Map<string, { request: ApiRequest; dirty: boolean }>();
  protected settings: ExtensionSettings;

  constructor(
    mementoForScope: (scope: 'workspace' | 'global') => import('vscode').Memento,
    secrets: import('vscode').SecretStorage,
    protected readonly host: HostAdapter,
    initialSettings: ExtensionSettings
  ) {
    this.settings = initialSettings;
    this.secrets = new SecretService(secrets);
    this.auth = new AuthService(this.secrets, this.http);
    const memento = mementoForScope(this.settings.storageScope);
    this.storage = new StorageManager(memento);
    const makeEmitter = <T,>() => new SimpleEmitter<T>() as EmitterLike<T>;

    this.collections = new CollectionService(this.storage, this.secrets, makeEmitter());
    this.environments = new EnvironmentService(this.storage, this.secrets, makeEmitter());
    this.history = new HistoryService(this.storage, makeEmitter());
    this.websockets = new WebSocketService();
    this.scriptRunner = new ScriptRunner();
    this.execution = new RequestExecutionService({
      http: this.http,
      auth: this.auth,
      scripts: this.scriptRunner,
      onAuthUpdated: (request, oauth) => {
        const stored = this.collections.getRequest(request.id);
        if (stored && stored.auth.type === 'oauth2') {
          const updated = {
            ...stored,
            auth: { ...stored.auth, oauth2: { ...oauth, clientSecret: stored.auth.oauth2?.clientSecret ?? '' } }
          };
          this.collections.saveRequest(updated);
        }
      }
    });

    this.runner = new CollectionRunner({
      execution: this.execution,
      collections: this.collections,
      onProgress: (summary) => this.post({ type: 'run:progress', payload: { run: summary } })
    });

    this.applySettings();
    this.watchSources();
  }

  protected watchSources(): void {
    this.collections.onChange(() => this.onStateChanged('collections'));
    this.environments.onDidChange(() => this.onStateChanged('environments'));
    this.history.onDidChange(() => this.onStateChanged('history'));
    this.websockets.onUpdate((session) => this.post({ type: 'websocket:update', payload: { session } }));
  }

  protected onStateChanged(_reason: string): void {
    /* subclasses override to refresh editors/providers */
  }

  /* ------------------------------- settings -------------------------------- */

  applySettings(): void {
    this.history.configure({
      enabled: this.settings.historyEnabled,
      limit: this.settings.historyLimit,
      retentionDays: this.settings.historyRetentionDays,
      storeRequestBody: this.settings.historyStoreRequestBody,
      redactSensitiveHeaders: this.settings.historyRedactSensitiveHeaders
    });
  }

  updateSettings(settings: ExtensionSettings): void {
    this.settings = settings;
    this.applySettings();
  }

  get executionSettings() {
    return {
      timeoutMs: this.settings.timeout,
      followRedirects: this.settings.followRedirects === 'follow',
      maxRedirects: this.settings.maxRedirects,
      verifyTls: this.settings.verifyTls,
      maxResponseBytes: this.settings.maxResponseSize,
      maxDisplayBytes: this.settings.maxDisplaySize,
      allowPrivateNetwork: this.settings.allowPrivateNetwork,
      trustedHosts: this.settings.trustedHosts,
      scriptTimeoutMs: this.settings.scriptTimeoutMs,
      scriptMemoryMb: this.settings.scriptMemoryMb,
      runScripts: true
    };
  }

  get extensionSettings(): ExtensionSettings {
    return this.settings;
  }

  /* ------------------------------- transport ------------------------------- */

  attachTransport(transport: ClientTransport): { dispose(): void } {
    this.transport = transport;
    const subscription = transport.onMessage((raw) => {
      void this.handleMessage(raw);
    });
    void this.broadcastState();
    return subscription;
  }

  detachTransport(): void {
    this.transport = undefined;
  }

  protected post(message: unknown): void {
    try {
      this.transport?.post(message);
    } catch {
      // The panel may have been disposed between a state change and the post.
    }
  }

  async broadcastState(): Promise<void> {
    this.post({ type: 'state:snapshot', payload: await this.buildSnapshot() });
  }

  async buildSnapshot(): Promise<AppSnapshot> {
    const annotated = await this.environments.annotateSecrets(this.environments.snapshot());
    return {
      version: 1,
      collections: this.collections.listCollections(),
      folders: this.collections.listFolders(),
      requests: this.collections.listRequests(),
      environments: annotated,
      activeEnvironmentId: this.environments.getActiveId(),
      history: this.history.list(),
      settings: toWebviewSettings(this.settings),
      tools: { websocket: this.websockets.current() }
    };
  }

  /** Message handler; exposed for tests so they can drive the protocol directly. */
  async handleMessage(raw: unknown): Promise<void> {
    let message;
    try {
      message = validateMessage(raw);
    } catch (error) {
      const reason = error instanceof SecurityError ? error.message : 'Invalid message';
      this.post({ type: 'error', payload: { title: 'Invalid message', message: reason } });
      return;
    }
    const payload = (message.payload ?? {}) as Record<string, unknown>;
    const requestId = message.requestId;

    try {
      switch (message.type) {
        case 'webview:ready':
          await this.broadcastState();
          break;
        case 'request:send':
          await this.handleSend(payload, requestId);
          break;
        case 'request:cancel':
          this.cancelRequest(String(payload.requestId ?? requestId ?? ''));
          break;
        case 'request:save':
          await this.handleSave(payload);
          break;
        case 'request:delete':
          await this.handleDeleteRequest(String(payload.id ?? ''));
          break;
        case 'request:duplicate':
          this.collections.duplicateRequest(String(payload.id ?? ''));
          break;
        case 'request:open':
          await this.handleOpenRequest(String(payload.id ?? ''));
          break;
        case 'request:resend-history':
          await this.handleResendHistory(String(payload.id ?? ''));
          break;
        case 'request:set-name': {
          const id = String(payload.id ?? '');
          const name = validateName(String(payload.name ?? ''), 'Request name');
          const request = this.collections.getRequest(id);
          if (request) {
            this.collections.saveRequest({ ...request, name });
          } else {
            const open = this.openDocuments.get(id);
            if (open) {
              open.request = { ...open.request, name };
              open.dirty = true;
            }
          }
          break;
        }
        case 'request:picker-files': {
          const files = await this.host.openFiles({ canSelectMany: true, openLabel: 'Use file' });
          this.post({ type: 'response:files', requestId, payload: { files } });
          break;
        }
        case 'run:start':
          await this.handleRunStart(payload, requestId);
          break;
        case 'run:cancel': {
          const runId = String(payload.runId ?? '');
          const pending = this.pendingRuns.get(runId);
          if (pending) {
            pending.controller.abort();
            this.pendingRuns.delete(runId);
          }
          break;
        }
        case 'collection:create':
          this.collections.createCollection(validateName(String(payload.name ?? 'New Collection'), 'Collection name'));
          await this.broadcastState();
          break;
        case 'collection:update':
          this.collections.updateCollection(String(payload.id ?? ''), payload.patch as never);
          await this.broadcastState();
          break;
        case 'collection:delete':
          await this.confirmAndDelete('collection', String(payload.id ?? ''));
          break;
        case 'collection:duplicate':
          this.collections.duplicateCollection(String(payload.id ?? ''));
          break;
        case 'folder:create':
          this.collections.createFolder(
            String(payload.collectionId ?? ''),
            validateName(String(payload.name ?? 'New Folder'), 'Folder name'),
            payload.parentFolderId ? String(payload.parentFolderId) : null
          );
          await this.broadcastState();
          break;
        case 'folder:update':
          this.collections.updateFolder(String(payload.id ?? ''), payload.patch as never);
          await this.broadcastState();
          break;
        case 'folder:delete':
          await this.confirmAndDelete('folder', String(payload.id ?? ''));
          break;
        case 'environment:create':
          this.environments.create(String(payload.name ?? 'New Environment'));
          await this.broadcastState();
          break;
        case 'environment:update':
          this.environments.rename(String(payload.id ?? ''), String(payload.name ?? ''));
          break;
        case 'environment:delete':
          await this.confirmAndDelete('environment', String(payload.id ?? ''));
          break;
        case 'environment:duplicate':
          await this.environments.duplicate(String(payload.id ?? ''));
          break;
        case 'environment:set-active':
          this.environments.setActive(payload.id ? String(payload.id) : null);
          break;
        case 'environment:save-variables':
          await this.environments.saveVariables(String(payload.id ?? ''), (payload.variables ?? []) as ApiEnvironment['variables']);
          await this.broadcastState();
          break;
        case 'environment:clear-secret':
          await this.environments.clearSecret(String(payload.environmentId ?? ''), String(payload.variableId ?? ''));
          await this.broadcastState();
          break;
        case 'history:clear':
          this.history.clear();
          await this.broadcastState();
          break;
        case 'history:delete':
          this.history.remove(String(payload.id ?? ''));
          await this.broadcastState();
          break;
        case 'history:search':
          this.post({ type: 'history:results', requestId, payload: { entries: this.history.search(String(payload.query ?? '')) } });
          break;
        case 'auth:store-secret':
          await this.handleStoreSecret(payload);
          break;
        case 'auth:clear-secret': {
          const id = String(payload.requestId ?? '');
          await this.secrets.delete(AuthService.secretKeyForRequest(id));
          this.post({ type: 'auth:secret-state', payload: { requestId: id, hasSecret: false } });
          break;
        }
        case 'websocket:connect':
          await this.handleWebSocketConnect(payload);
          break;
        case 'websocket:send':
          this.websockets.send(String(payload.message ?? ''));
          break;
        case 'websocket:disconnect':
          this.websockets.disconnect();
          break;
        case 'websocket:clear':
          this.websockets.clearLog();
          break;
        case 'import:run':
          await this.runImport(String(payload.format ?? 'auto'));
          break;
        case 'export:collection':
          await this.exportCollection(String(payload.collectionId ?? ''), payload.sanitizeSecrets === true);
          break;
        case 'export:environments':
          await this.exportEnvironments();
          break;
        case 'export:request-curl':
          await this.copyAsCurl(payload);
          break;
        case 'settings:update':
          await this.handleUpdateSetting(payload);
          break;
        case 'settings:open':
          // The webview renders its own dialog from the snapshot; this keeps the latest values
          // in sync when the gear is clicked.
          await this.broadcastState();
          break;
        case 'settings:open-native':
          // Opens the editor's settings page (no-op in the harness, which has no settings UI).
          await this.host.openSettings();
          break;
        case 'ui:open-external': {
          const url = String(payload.url ?? '');
          if (/^https?:\/\//i.test(url)) {
            await this.host.openExternal(url);
          }
          break;
        }
        case 'ui:toast':
          this.post({ type: 'toast', payload: { level: payload.level ?? 'info', message: String(payload.message ?? '') } });
          break;
        default:
          this.post({ type: 'error', payload: { title: 'Unknown message', message: `Unhandled message type "${message.type}".` } });
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.post({ type: 'error', payload: { title: 'Action failed', message: reason } });
      if (message.type === 'request:send' && requestId) {
        this.post({ type: 'request:finished', requestId, payload: { error: { kind: 'unknown', message: reason } } });
      }
    }
  }

  /* -------------------------------- requests ------------------------------- */

  private async handleRunStart(payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const collectionId = String(payload.collectionId ?? '');
    const folderId = payload.folderId ? String(payload.folderId) : undefined;
    const environment = await this.environmentWithSecrets();
    const controller = new AbortController();
    const runId = `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.pendingRuns.set(runId, { controller, startedAt: Date.now() });
    try {
      const summary = await this.runner.run({
        collectionId,
        folderId,
        environment,
        settings: this.executionSettings,
        signal: controller.signal,
        workspaceRoot: this.workspaceRoot
      });
      this.post({ type: 'run:finished', requestId, payload: { run: { ...summary, runId } } });
      // A batch run is also history: every request recorded as if it were sent by hand, reusing the
      // same result shape so timings, status and test counts stay identical.
      for (const item of summary.items) {
        const request = this.collections.getRequest(item.requestId);
        if (request && item.resolved) {
          this.history.record(request, {
            requestId: item.requestId,
            resolved: item.resolved,
            tests: item.tests,
            error: item.error,
            durationMs: item.durationMs
          });
        }
      }
      await this.broadcastState();
    } catch (error) {
      if (error instanceof RunAbortedError) {
        this.post({ type: 'run:cancelled', requestId, payload: { runId } });
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.post({ type: 'run:finished', requestId, payload: { error: { kind: 'unknown', message: reason } } });
    } finally {
      this.pendingRuns.delete(runId);
    }
  }

  private async handleSend(payload: Record<string, unknown>, requestId?: string): Promise<void> {
    const draft = payload.request as ApiRequest | undefined;
    if (!draft) {
      throw new SecurityError('No request provided.', 'invalid-input');
    }
    const id = draft.id || requestId || 'draft';
    this.cancelRequest(id);

    const controller = new AbortController();
    this.pendingRequests.set(id, { controller, startedAt: Date.now() });
    this.post({ type: 'request:started', requestId: id, payload: {} });

    const environment = await this.environmentWithSecrets();
    const collectionVariables = this.collections.getCollectionVariables(draft);
    const collectionHeaders = this.collections.getInheritedHeaders(draft);
    const collectionTests = this.collections.getInheritedTests(draft);

    try {
      const result = await this.execution.execute({
        request: draft,
        environment,
        collectionVariables,
        collectionHeaders,
        collectionTests,
        settings: this.executionSettings,
        signal: controller.signal,
        verifyFileAccess: () => this.host.assertFileAccessAllowed(),
        workspaceRoot: this.workspaceRoot
      });
      this.pendingRequests.delete(id);
      this.post({ type: 'request:finished', requestId: id, payload: result });
      this.history.record(draft, result);
      await this.broadcastState();
    } catch (error) {
      this.pendingRequests.delete(id);
      const details: HttpErrorDetails =
        error instanceof SecurityError
          ? { kind: 'blocked-address', message: error.message }
          : { kind: 'unknown', message: redactSecrets(error instanceof Error ? error.message : String(error)) };
      this.post({ type: 'request:finished', requestId: id, payload: { error: details } as Partial<SendRequestResult> });
    }
  }

  /** Workspace root used to expand `${workspaceFolder}/…` file paths; null outside a folder. */
  protected get workspaceRoot(): string | null {
    return this.host.workspaceRoot ? this.host.workspaceRoot() : null;
  }

  private async environmentWithSecrets(): Promise<ApiEnvironment | undefined> {
    const active = this.environments.getActive();
    if (!active) {
      return undefined;
    }
    const values = await this.environments.resolveValues(active.id);
    return {
      ...active,
      variables: active.variables.map((variable) =>
        variable.secret ? { ...variable, value: values[variable.key] ?? variable.value } : variable
      )
    };
  }

  cancelRequest(requestId: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      pending.controller.abort();
      this.pendingRequests.delete(requestId);
      this.post({ type: 'request:cancelled', requestId });
    }
  }

  cancelAll(): void {
    for (const id of [...this.pendingRequests.keys()]) {
      this.cancelRequest(id);
    }
  }

  private async handleSave(payload: Record<string, unknown>): Promise<void> {
    const request = payload.request as ApiRequest | undefined;
    if (!request) {
      throw new SecurityError('No request provided.', 'invalid-input');
    }
    // Credentials go to SecretStorage; only a reference stays in the document.
    const auth = await this.auth.persistSecret(request.id, request.auth);
    // A brand new request needs a home so it does not vanish from the explorer.
    let collectionId = request.collectionId;
    if (!collectionId) {
      const collections = this.collections.listCollections();
      collectionId = collections.length ? collections[0].id : this.collections.createCollection('My Collection').id;
    }
    const saved = this.collections.saveRequest({ ...request, auth, collectionId });
    this.openDocuments.set(saved.id, { request: saved, dirty: false });
    this.post({ type: 'request:saved', payload: { request: saved } });
    await this.broadcastState();
  }

  private async handleDeleteRequest(id: string): Promise<void> {
    const request = this.collections.getRequest(id) ?? this.openDocuments.get(id)?.request;
    if (!request) {
      return;
    }
    if (this.settings.confirmBeforeDelete) {
      const confirmed = await this.host.confirm(`Delete "${request.name}"? This cannot be undone.`, 'Delete');
      if (!confirmed) {
        return;
      }
    }
    this.collections.deleteRequest(id);
    this.openDocuments.delete(id);
    await this.broadcastState();
  }

  private async handleOpenRequest(id: string): Promise<void> {
    const request = this.collections.getRequest(id);
    if (!request) {
      throw new SecurityError('The request no longer exists.', 'invalid-input');
    }
    const hasSecret = await this.auth.hasStoredSecret(request.auth.secretRef);
    this.post({
      type: 'request:opened',
      payload: { request: this.sanitiseRequestForClient(request), hasSecret }
    });
  }

  /** Replaces stored credentials with a placeholder before sending the request to the webview. */
  private sanitiseRequestForClient(request: ApiRequest): ApiRequest {
    const auth = { ...request.auth };
    if (auth.secretRef) {
      if (auth.type === 'basic') {
        auth.password = MASK;
      } else if (auth.type === 'api-key') {
        auth.keyValue = MASK;
      } else if (auth.type === 'bearer') {
        auth.token = MASK;
      } else if (auth.type === 'oauth2' && auth.oauth2) {
        auth.oauth2 = { ...auth.oauth2, clientSecret: MASK };
      }
    }
    return { ...request, auth };
  }

  private async handleResendHistory(id: string): Promise<void> {
    const entry = this.history.get(id);
    if (!entry?.request) {
      throw new SecurityError('This history entry has no stored request.', 'invalid-input');
    }
    const hasSecret = await this.auth.hasStoredSecret(entry.request.auth.secretRef);
    this.post({ type: 'request:opened', payload: { request: this.sanitiseRequestForClient(entry.request), hasSecret } });
  }

  private async handleStoreSecret(payload: Record<string, unknown>): Promise<void> {
    const requestId = String(payload.requestId ?? '');
    const auth = payload.auth as ApiRequest['auth'];
    const updated = await this.auth.persistSecret(requestId, auth);
    const open = this.openDocuments.get(requestId);
    if (open) {
      open.request = { ...open.request, auth: updated };
      open.dirty = true;
    }
    this.post({ type: 'auth:secret-state', payload: { requestId, hasSecret: await this.auth.hasStoredSecret(updated.secretRef) } });
    this.post({ type: 'request:auth-updated', payload: { requestId, auth: updated } });
  }

  private async confirmAndDelete(kind: 'collection' | 'folder' | 'environment', id: string): Promise<void> {
    const name =
      kind === 'collection'
        ? this.collections.getCollection(id)?.name
        : kind === 'folder'
          ? this.collections.getFolder(id)?.name
          : this.environments.get(id)?.name;
    if (!name) {
      return;
    }
    if (this.settings.confirmBeforeDelete) {
      const detail =
        kind === 'collection'
          ? ' All folders and requests inside it will be deleted.'
          : kind === 'folder'
            ? ' Folders and requests inside it will be deleted.'
            : '';
      const confirmed = await this.host.confirm(`Delete ${kind} "${name}"?${detail}`, 'Delete');
      if (!confirmed) {
        return;
      }
    }
    if (kind === 'collection') {
      await this.collections.deleteCollection(id);
    } else if (kind === 'folder') {
      this.collections.deleteFolder(id);
    } else {
      await this.environments.delete(id);
    }
    await this.broadcastState();
  }

  /* -------------------------------- websocket ------------------------------ */

  private async handleWebSocketConnect(payload: Record<string, unknown>): Promise<void> {
    const url = String(payload.url ?? '');
    const headers = ((payload.headers ?? []) as KeyValueRow[]).filter((header) => header.enabled !== false && header.key);
    const environment = await this.environmentWithSecrets();
    const resolvedHeaders = headers.map((header) => ({ key: header.key, value: this.resolveText(header.value, environment) }));
    const session = await this.websockets.connect({
      url: this.resolveText(url, environment),
      headers: resolvedHeaders,
      verifyTls: this.settings.verifyTls,
      handshakeTimeoutMs: this.settings.websocketHandshakeTimeoutMs,
      maxMessages: this.settings.websocketMaxMessages,
      allowPrivateNetwork: this.settings.allowPrivateNetwork,
      trustedHosts: this.settings.trustedHosts
    });
    this.post({ type: 'websocket:update', payload: { session } });
  }

  getWebSocketSession(): WebSocketSessionInfo | null {
    return this.websockets.current();
  }

  private resolveText(text: string, environment: ApiEnvironment | undefined): string {
    if (!environment) {
      return text;
    }
    return text.replace(/\{\{\s*([A-Za-z0-9_.\-$]+)\s*\}\}/g, (match, name: string) => {
      const variable = environment.variables.find((candidate) => candidate.key === name && candidate.enabled);
      return variable ? variable.value : match;
    });
  }

  /* ------------------------------ import/export ---------------------------- */

  async runImport(format: string): Promise<void> {
    const filters: Record<string, string[]> = {
      'ely-api-client': ['json'],
      postman: ['json'],
      openapi: ['json'],
      curl: ['txt', 'sh'],
      auto: ['json', 'txt', 'sh']
    };
    const files = await this.host.openFiles({
      canSelectMany: false,
      openLabel: 'Import',
      filters: { 'Supported files': filters[format] ?? ['json'] }
    });
    if (!files.length) {
      return;
    }
    await this.importFromPath(files[0], format === 'auto' ? undefined : (format as never));
  }

  /** Imports a file by path; shared by the client and the commands. */
  async importFromPath(path: string, format?: 'native' | 'postman' | 'openapi' | 'environment' | 'curl'): Promise<void> {
    const bytes = await this.host.readFile(path);
    if (bytes.byteLength > this.settings.maxImportSizeBytes) {
      throw new SecurityError(
        `The file is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB, above the ${(this.settings.maxImportSizeBytes / 1024 / 1024).toFixed(1)} MB import limit.`,
        'payload-too-large'
      );
    }
    const text = Buffer.from(bytes).toString('utf8');
    const imported = this.importExport.import(text, { maxBytes: this.settings.maxImportSizeBytes, format });

    if (imported.environments.length) {
      const existing = this.environments.list();
      await this.environments.replaceAll([...existing, ...imported.environments], this.environments.getActiveId());
      for (const [secretKey, value] of Object.entries(imported.secrets)) {
        await this.secrets.store(secretKey, value);
      }
    }
    if (imported.collections.length || imported.requests.length) {
      await this.collections.importCollections(
        { collections: imported.collections, folders: imported.folders, requests: imported.requests },
        imported.secrets
      );
    }
    await this.broadcastState();
    const warnings = imported.warnings.length ? ` ${imported.warnings.length} warning(s); see the client.` : '';
    await this.host.notify(`ElyApiClient imported ${imported.summary}.${warnings}`, 'info');
    this.post({ type: 'toast', payload: { level: 'success', message: `Imported ${imported.summary}.`, warnings: imported.warnings } });
  }

  async exportCollection(collectionId: string, sanitizeSecrets: boolean): Promise<string | undefined> {
    const collection = this.collections.getCollection(collectionId);
    if (!collection) {
      return undefined;
    }
    const data = this.importExport.exportNative(
      {
        collections: [collection],
        folders: this.collections.listFolders(collectionId),
        requests: this.collections.listRequests(collectionId)
      },
      { sanitizeSecrets }
    );
    const target = await this.host.saveFile({
      defaultName: `${collection.name.replace(/[^\w.-]+/g, '-')}.ely.json`,
      filters: { JSON: ['json'] }
    });
    if (!target) {
      return undefined;
    }
    await this.host.writeFile(target, Buffer.from(this.importExport.serialise(data), 'utf8'));
    await this.host.notify(`ElyApiClient exported "${collection.name}".`, 'info');
    return target;
  }

  async exportEnvironments(): Promise<string | undefined> {
    const environments = this.environments.list();
    const data = this.importExport.exportEnvironments(environments, { sanitizeSecrets: true });
    const target = await this.host.saveFile({ defaultName: 'ely-environments.json', filters: { JSON: ['json'] } });
    if (!target) {
      return undefined;
    }
    await this.host.writeFile(target, Buffer.from(this.importExport.serialise(data), 'utf8'));
    await this.host.notify(`ElyApiClient exported ${environments.length} environment(s).`, 'info');
    return target;
  }

  async copyAsCurl(payload: Record<string, unknown>): Promise<void> {
    const request = payload.request as ApiRequest | undefined;
    if (!request) {
      return;
    }
    await this.host.copyToClipboard(this.importExport.toCurl(request));
    this.post({ type: 'toast', payload: { level: 'success', message: 'cURL command copied to the clipboard.' } });
  }

  private async handleUpdateSetting(payload: Record<string, unknown>): Promise<void> {
    const key = String(payload.key ?? '');
    const value = payload.value;
    const allowed = new Set([
      'defaultMethod',
      'timeout',
      'followRedirects',
      'verifyTls',
      'prettyPrint',
      'theme',
      'confirmBeforeDelete',
      'historyEnabled',
      'maxRedirects',
      'maxDisplaySize',
      'historyLimit',
      'scriptTimeoutMs',
      'allowPrivateNetwork',
      'websocketMaxMessages',
      'confirmBeforeDelete'
    ]);
    if (!allowed.has(key)) {
      throw new SecurityError(`Unknown setting "${key}".`, 'invalid-input');
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new SecurityError('Invalid setting value.', 'invalid-input');
    }
    await this.host.updateSetting(key, value);
    // The editor reports the persisted value back through `updateSettings()`; applying it here as
    // well keeps the headless harness and tests (which have no settings store) consistent, and
    // makes the dialog show the new value immediately.
    this.updateSettings({ ...this.settings, [key]: value } as ExtensionSettings);
    await this.broadcastState();
  }

  /* ------------------------------ new documents ---------------------------- */

  async createDraftRequest(collectionId?: string): Promise<ApiRequest> {
    const draft = createRequest({ collectionId, method: this.settings.defaultMethod, name: 'Untitled Request' });
    draft.id = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    return draft;
  }

  async newRequest(): Promise<ApiRequest> {
    const request = await this.createDraftRequest();
    this.post({ type: 'request:opened', payload: { request, isNew: true } });
    return request;
  }

  sendActiveRequest(): void {
    this.post({ type: 'command:send' });
  }

  saveActiveRequest(): void {
    this.post({ type: 'command:save' });
  }

  async openRequestInPanel(id: string): Promise<void> {
    await this.handleOpenRequest(id);
  }

  openEnvironmentEditor(id: string): void {
    this.post({ type: 'environment:open-editor', payload: { id } });
  }

  async resendHistory(id: string): Promise<void> {
    await this.handleResendHistory(id);
  }

  renameOpenRequest(id: string, name: string): void {
    this.post({ type: 'request:rename', payload: { id, name } });
  }

  closeRequestTab(id: string): void {
    this.post({ type: 'request:close', payload: { id } });
  }

  openWebSocketWorkspace(): void {
    this.post({ type: 'websocket:open-workspace' });
  }

  duplicateFolder(id: string): void {
    const folder = this.collections.getFolder(id);
    if (!folder) {
      return;
    }
    const copy = this.collections.createFolder(folder.collectionId, `${folder.name} (copy)`, folder.parentFolderId);
    if (!copy) {
      return;
    }
    this.collections.updateFolder(copy.id, { description: folder.description, scripts: folder.scripts });
    for (const request of this.collections.listRequests(folder.collectionId).filter((r) => r.folderId === id)) {
      const clone = { ...request, id: createRequest().id, folderId: copy.id, name: request.name };
      this.collections.saveRequest(clone);
    }
  }

  dispose(): void {
    this.cancelAll();
    this.websockets.dispose();
    this.scriptRunner.dispose();
    void this.collections.flush();
    void this.environments.flush();
    void this.history.flush();
    this.storage.dispose();
  }
}

/* ------------------------------- emitters --------------------------------- */

/** Minimal event emitter with the VS Code shape (`event`, `fire`, `dispose`). */
export class SimpleEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export type EventEmitterLike<T> = EmitterLike<T>;

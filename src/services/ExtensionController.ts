import * as vscode from 'vscode';
import { homedir } from 'node:os';
import type { HostAdapter } from './AppCore';
import { AppCore } from './AppCore';
import { readWorkspaceSettings } from './SettingsService';

export type { ClientTransport } from './AppCore';

/**
 * VS Code host adapter: the only place where the client touches editor UI.
 *
 * Everything else (protocol, services, HTTP, scripts) lives in `AppCore`, which is framework
 * independent. This keeps the editor integration small and makes the exact same application logic
 * testable — and runnable in the browser UI harness — without a VS Code installation.
 */
export class VsCodeHostAdapter implements HostAdapter {
  constructor(
    private readonly context: vscode.ExtensionContext
  ) {}

  async openFiles(options: { canSelectMany: boolean; openLabel?: string; filters?: Record<string, string[]> }): Promise<string[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: options.canSelectMany,
      openLabel: options.openLabel,
      filters: options.filters
    });
    return (uris ?? []).map((uri) => uri.fsPath);
  }

  async saveFile(options: { defaultName: string; filters?: Record<string, string[]> }): Promise<string | null> {
    const uri = await vscode.window.showSaveDialog({
      saveLabel: 'Export',
      filters: options.filters,
      defaultUri: vscode.Uri.joinPath(this.workspaceRootUri() ?? vscode.Uri.file(homedir()), options.defaultName)
    });
    return uri ? uri.fsPath : null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    return vscode.workspace.fs.readFile(vscode.Uri.file(path));
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await vscode.workspace.fs.writeFile(vscode.Uri.file(path), content);
  }

  async confirm(message: string, confirmLabel: string): Promise<boolean> {
    const answer = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return answer === confirmLabel;
  }

  async notify(message: string, level: 'info' | 'warning' | 'error' = 'info'): Promise<void> {
    if (level === 'error') {
      await vscode.window.showErrorMessage(message);
    } else if (level === 'warning') {
      await vscode.window.showWarningMessage(message);
    } else {
      await vscode.window.showInformationMessage(message);
    }
  }

  async openSettings(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'elyApiClient');
  }

  async openExternal(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url, true));
  }

  async copyToClipboard(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
  }

  async updateSetting(key: string, value: string | number | boolean): Promise<void> {
    const map: Record<string, string> = {
      defaultMethod: 'request.defaultMethod',
      timeout: 'http.timeout',
      followRedirects: 'http.followRedirects',
      verifyTls: 'http.verifyTls',
      prettyPrint: 'response.prettyPrint',
      theme: 'ui.theme',
      confirmBeforeDelete: 'security.confirmBeforeDelete',
      historyEnabled: 'history.enabled',
      maxRedirects: 'http.maxRedirects',
      maxDisplaySize: 'response.maxDisplaySize'
    };
    const settingKey = map[key];
    if (!settingKey) {
      throw new Error(`Unknown setting "${key}".`);
    }
    await vscode.workspace.getConfiguration('elyApiClient').update(settingKey, value, vscode.ConfigurationTarget.Global);
  }

  isWorkspaceTrusted(): boolean {
    return vscode.workspace.isTrusted;
  }

  assertFileAccessAllowed(): void {
    if (!vscode.workspace.isTrusted) {
      throw new Error('Reading files is disabled in Restricted Mode. Trust the workspace to send file bodies.');
    }
  }

  workspaceRoot(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private workspaceRootUri(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  get contextHandle(): vscode.ExtensionContext {
    return this.context;
  }
}

/**
 * Extension-side controller. Adds VS Code specifics (configuration, dialogs, trust) on top of the
 * shared `AppCore` and re-emits state changes as a VS Code event so providers can refresh.
 */
export class ExtensionController extends AppCore implements vscode.Disposable {
  readonly onDidChangeState = new vscode.EventEmitter<{ reason: string }>();
  readonly onDidChangeEnvironment = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly hostAdapter: VsCodeHostAdapter;

  constructor(context: vscode.ExtensionContext) {
    const host = new VsCodeHostAdapter(context);
    const settings = readWorkspaceSettings(vscode.workspace.getConfiguration('elyApiClient'));
    super(
      (scope) => (scope === 'global' ? context.globalState : context.workspaceState),
      context.secrets,
      host,
      settings
    );
    this.hostAdapter = host;

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration('elyApiClient')) {
          return;
        }
        const previousScope = this.settings.storageScope;
        this.updateSettings(readWorkspaceSettings(vscode.workspace.getConfiguration('elyApiClient')));
        if (previousScope !== this.settings.storageScope) {
          void vscode.window.showInformationMessage('ElyApiClient: reload the window to apply the new storage scope.');
        }
        this.onDidChangeState.fire({ reason: 'settings' });
        void this.broadcastState();
      })
    );
  }

  get hostAdapterHandle(): VsCodeHostAdapter {
    return this.hostAdapter;
  }

  protected override onStateChanged(reason: string): void {
    this.onDidChangeState.fire({ reason });
    if (reason === 'environments') {
      this.onDidChangeEnvironment.fire();
    }
  }

  override dispose(): void {
    super.dispose();
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.onDidChangeState.dispose();
    this.onDidChangeEnvironment.dispose();
  }
}

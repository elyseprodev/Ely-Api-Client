import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ExtensionController } from '../services/ExtensionController';
import { escapeHtml } from '../security/Sanitizer';

/**
 * The panel provider renders the client HTML and wires the webview to the controller.
 *
 * Security model:
 *  - strict CSP with a per-load nonce; only our own scripts may run
 *  - scripts load from `media/` via `webview.asWebviewUri`, never inline
 *  - command URIs, forms and the find widget are disabled
 *  - the controller validates every inbound message (`SecurityValidator`)
 *
 * The webview is abstracted behind `WebviewHost` so the same rendering code runs in the browser
 * harness (used for screenshots and manual QA) and inside the editor.
 */

export interface WebviewHost {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): vscode.Disposable;
  asWebviewUri(uri: vscode.Uri): string;
  cspSource: string;
  onDispose(listener: () => void): void;
  setHtml?(html: string): void;
}

export interface WebviewHostOptions {
  title: string;
  extensionUri: vscode.Uri;
  iconPath: vscode.Uri;
}

export interface WebviewHostFactory {
  create(options: WebviewHostOptions): WebviewHost;
}

/** Factory backed by a real VS Code webview panel. */
export class VsCodePanelFactory implements WebviewHostFactory {
  static readonly viewType = 'elyApiClient.panel';
  private panel: vscode.WebviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  create(options: WebviewHostOptions): WebviewHost {
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        VsCodePanelFactory.viewType,
        options.title,
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [vscode.Uri.joinPath(options.extensionUri, 'media')],
          enableCommandUris: false,
          enableForms: false,
          enableFindWidget: false
        }
      );
      panel.iconPath = options.iconPath;
      panel.onDidDispose(() => this.disposables.forEach((disposable) => disposable.dispose()));
      this.panel = panel;
    }
    const panel = this.panel;
    return {
      post: (message) => {
        void panel.webview.postMessage(message);
      },
      onMessage: (listener) =>
        panel.webview.onDidReceiveMessage((message) => {
          listener(message);
        }),
      asWebviewUri: (uri) => panel.webview.asWebviewUri(uri).toString(),
      cspSource: panel.webview.cspSource,
      onDispose: (listener) => {
        this.disposables.push(panel.onDidDispose(listener));
      },
      setHtml: (html) => {
        panel.webview.html = html;
      }
    };
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  reveal(): void {
    this.panel?.reveal(vscode.ViewColumn.One, false);
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
    this.panel?.dispose();
    this.panel = undefined;
  }
}

export class ApiPanelProvider implements vscode.Disposable {
  static readonly viewType = 'elyApiClient.panel';

  private host: WebviewHost | undefined;
  private readonly factory: WebviewHostFactory;
  private subscription: vscode.Disposable | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ExtensionController,
    factory?: WebviewHostFactory
  ) {
    this.factory = factory ?? new VsCodePanelFactory();
  }

  get isVisible(): boolean {
    return this.host ? this.factory instanceof VsCodePanelFactory ? this.factory.visible : true : false;
  }

  show(reveal = true): void {
    if (this.host) {
      if (reveal && this.factory instanceof VsCodePanelFactory) {
        this.factory.reveal();
      }
      return;
    }
    const host = this.factory.create({
      title: 'ElyApiClient',
      extensionUri: this.extensionUri,
      iconPath: vscode.Uri.joinPath(this.extensionUri, 'media', 'icons', 'activity-bar.svg')
    });
    this.host = host;
    host.setHtml?.(this.renderHtml());
    const transport = {
      post: (message: unknown) => host.post(message),
      onMessage: (listener: (message: unknown) => void) => host.onMessage(listener)
    };
    this.subscription?.dispose();
    this.subscription = this.controller.attachTransport(transport);
    host.onDispose(() => {
      this.controller.detachTransport();
      this.subscription?.dispose();
      this.subscription = undefined;
      this.host = undefined;
      this.controller.cancelAll();
    });
  }

  /** Re-renders the HTML (theme changes, or the harness requesting a fresh document). */
  reload(): void {
    this.host?.setHtml?.(this.renderHtml());
  }

  private renderHtml(): string {
    const nonce = crypto.randomBytes(16).toString('base64').replace(/[^A-Za-z0-9]/g, '');
    const templatePath = path.join(this.extensionUri.fsPath, 'media', 'webview', 'index.html');
    let template: string;
    try {
      template = fs.readFileSync(templatePath, 'utf8');
    } catch {
      return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px"><h2>ElyApiClient</h2><p>The webview assets are missing from this installation (${escapeHtml(
        templatePath
      )}). Reinstall the extension.</p></body></html>`;
    }
    const toUri = (segments: string[]) =>
      this.host ? this.host.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...segments)) : `/${segments.join('/')}`;
    const cspSource = this.host?.cspSource ?? '';
    const scripts = ['core', 'json', 'components', 'app']
      .map((name) => `<script nonce="${nonce}" src="${toUri(['media', 'scripts', `${name}.js`])}"></script>`)
      .join('\n    ');
    return template
      .replace(/\{\{cspSource\}\}/g, cspSource)
      .replace(/\{\{nonce\}\}/g, nonce)
      .replace(/\{\{styleUri\}\}/g, toUri(['media', 'styles', 'main.css']))
      .replace('{{scripts}}', scripts);
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.host = undefined;
    if (this.factory instanceof VsCodePanelFactory) {
      this.factory.dispose();
    }
  }
}

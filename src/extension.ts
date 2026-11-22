import * as vscode from 'vscode';
import { ExtensionController } from './services/ExtensionController';
import { ApiPanelProvider } from './providers/ApiPanelProvider';
import { ApiSidebarProvider } from './providers/ApiSidebarProvider';
import { registerCommands } from './commands';
import { sanitizeErrorMessage } from './security/Sanitizer';

/**
 * Extension entry point.
 *
 * Everything is created up front by design: the client shares one `ExtensionController` instance
 * (storage, history, environments, HTTP, scripts) and the sidebar and webview both observe it.
 * Construction is cheap — no network, no file IO beyond VS Code's state store, which is read
 * synchronously from memory.
 */

let controller: ExtensionController | undefined;
let panel: ApiPanelProvider | undefined;
let sidebar: ApiSidebarProvider | undefined;
let output: vscode.LogOutputChannel | undefined;

function log(): vscode.LogOutputChannel {
  if (!output) {
    output = vscode.window.createOutputChannel('ElyApiClient', { log: true });
  }
  return output;
}

export function activate(context: vscode.ExtensionContext): void {
  try {
    log().info('ElyApiClient activating');

    controller = new ExtensionController(context);
    context.subscriptions.push(controller);

    panel = new ApiPanelProvider(context.extensionUri, controller);
    context.subscriptions.push(panel);

    sidebar = new ApiSidebarProvider(controller);
    context.subscriptions.push(sidebar);

    const treeView = vscode.window.createTreeView('elyApiClient.explorer', {
      treeDataProvider: sidebar,
      showCollapseAll: true,
      canSelectMany: false
    });
    treeView.message = 'Test APIs. Debug Faster. Build Better.';
    context.subscriptions.push(treeView);

    context.subscriptions.push(
      controller.onDidChangeState.event(() => {
        treeView.description = `${controller!.collections.listCollections().length} collections`;
      })
    );

    context.subscriptions.push(...registerCommands({ controller, panel, sidebar, context }));

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('elyApiClient.ui.theme')) {
          panel?.reload();
        }
      })
    );

    log().info('ElyApiClient activated');
  } catch (error) {
    log().error(`Activation failed: ${sanitizeErrorMessage(error)}`);
    void vscode.window.showErrorMessage(`ElyApiClient failed to activate: ${sanitizeErrorMessage(error)}`);
  }
}

export function deactivate(): void {
  try {
    controller?.dispose();
    panel?.dispose();
    sidebar?.dispose();
    output?.dispose();
  } catch (error) {
    // Deactivation must never throw.
    void error;
  } finally {
    controller = undefined;
    panel = undefined;
    sidebar = undefined;
    output = undefined;
  }
}

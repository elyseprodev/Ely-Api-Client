import * as vscode from 'vscode';
import type { ApiEnvironment } from '../models/types';
import type { ExtensionController } from '../services/ExtensionController';
import type { ApiPanelProvider } from '../providers/ApiPanelProvider';
import type { ApiSidebarProvider } from '../providers/ApiSidebarProvider';
import { validateName } from '../security/SecurityValidator';

/**
 * Registers every command contributed by package.json. Commands are thin: they validate input,
 * delegate to the controller services, and surface results through VS Code UI.
 */

interface TreeNodeLike {
  kind?: string;
  collection?: { id: string; name: string };
  folder?: { id: string; collectionId: string; name: string };
  request?: { id: string; name: string };
  environment?: ApiEnvironment;
  entry?: { id: string; url: string };
}

export interface CommandDependencies {
  controller: ExtensionController;
  panel: ApiPanelProvider;
  sidebar: ApiSidebarProvider;
  context: vscode.ExtensionContext;
}

async function pickCollection(controller: ExtensionController, title: string): Promise<string | undefined> {
  const collections = controller.collections.listCollections();
  if (!collections.length) {
    void vscode.window.showWarningMessage('ElyApiClient: create a collection first.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    collections.map((collection) => ({ label: collection.name, description: `${collection.id.slice(0, 8)}`, id: collection.id })),
    { title, placeHolder: 'Collection' }
  );
  return picked?.id;
}

export function registerCommands({ controller, panel, sidebar }: CommandDependencies): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  const register = (command: string, handler: (...args: never[]) => unknown) => {
    disposables.push(vscode.commands.registerCommand(command, handler as (...args: unknown[]) => unknown));
  };

  const nodeArg = (args: unknown[]): TreeNodeLike | undefined => {
    const first = args[0];
    return first && typeof first === 'object' && 'kind' in (first as object) ? (first as TreeNodeLike) : undefined;
  };

  const confirmDelete = async (label: string, detail = ''): Promise<boolean> => {
    if (!controller.extensionSettings.confirmBeforeDelete) {
      return true;
    }
    const answer = await vscode.window.showWarningMessage(`Delete ${label}?${detail}`, { modal: true }, 'Delete');
    return answer === 'Delete';
  };

  register('elyApiClient.openClient', async () => {
    panel.show(true);
    await controller.broadcastState();
  });

  register('elyApiClient.newRequest', async () => {
    panel.show(true);
    await controller.newRequest();
  });

  register('elyApiClient.sendRequest', async () => {
    panel.show(true);
    controller.sendActiveRequest();
  });

  register('elyApiClient.saveRequest', async () => {
    panel.show(true);
    controller.saveActiveRequest();
  });

  register('elyApiClient.newCollection', async () => {
    const name = await vscode.window.showInputBox({
      title: 'New collection',
      prompt: 'Name for the new collection',
      value: 'New Collection',
      validateInput: (value) => (value.trim() ? undefined : 'The name cannot be empty')
    });
    if (!name) {
      return;
    }
    const collection = controller.collections.createCollection(validateName(name, 'Collection name'));
    sidebar.refresh();
    await controller.broadcastState();
    void vscode.window.showInformationMessage(`Created collection "${collection.name}".`);
  });

  register('elyApiClient.newFolder', async (...args) => {
    const node = nodeArg(args);
    const collectionId =
      node?.kind === 'collection' ? node.collection?.id : node?.kind === 'folder' ? node.folder?.collectionId : undefined;
    const targetCollection = collectionId ?? (await pickCollection(controller, 'Choose the collection for the new folder'));
    if (!targetCollection) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'New folder',
      prompt: 'Folder name',
      value: 'New Folder'
    });
    if (!name) {
      return;
    }
    const parentFolderId = node?.kind === 'folder' ? (node.folder?.id ?? null) : null;
    controller.collections.createFolder(targetCollection, name, parentFolderId);
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.newEnvironment', async () => {
    const name = await vscode.window.showInputBox({
      title: 'New environment',
      prompt: 'Environment name (e.g. Local, Staging, Production)',
      value: 'Development'
    });
    if (!name) {
      return;
    }
    const environment = controller.environments.create(name);
    controller.environments.setActive(environment.id);
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.importCollection', async () => {
    panel.show(true);
    await controller.runImport('auto');
    sidebar.refresh();
  });

  register('elyApiClient.exportCollection', async (...args) => {
    const node = nodeArg(args);
    let collectionId = node?.collection?.id;
    if (!collectionId) {
      collectionId = await pickCollection(controller, 'Choose a collection to export');
    }
    if (!collectionId) {
      return;
    }
    const mode = await vscode.window.showQuickPick(
      [
        {
          label: 'Full export',
          detail: 'Requests exactly as stored. Credentials live in SecretStorage and are never included.',
          value: false
        },
        { label: 'Sanitised export', detail: 'Also strip authentication configuration from requests.', value: true }
      ],
      { title: 'Export options', placeHolder: 'Choose export mode' }
    );
    if (!mode) {
      return;
    }
    await controller.exportCollection(collectionId, mode.value);
  });

  register('elyApiClient.clearHistory', async () => {
    const entryCount = controller.history.list().length;
    if (!entryCount) {
      void vscode.window.showInformationMessage('ElyApiClient history is already empty.');
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Clear ${entryCount} history entr${entryCount === 1 ? 'y' : 'ies'}? Saved requests are not affected.`,
      { modal: true },
      'Clear history'
    );
    if (answer !== 'Clear history') {
      return;
    }
    controller.history.clear();
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.openWebSocket', async () => {
    panel.show(true);
    await controller.openWebSocketWorkspace();
  });

  register('elyApiClient.openSettings', async () => {
    await vscode.commands.executeCommand('workbench.action.openSettings', 'elyApiClient');
  });

  register('elyApiClient.refreshExplorer', async () => {
    controller.collections.reload();
    controller.environments.reload();
    controller.history.reload();
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.deleteNode', async (...args) => {
    const node = nodeArg(args);
    if (!node) {
      return;
    }
    if (node.kind === 'request' && node.request) {
      if (!(await confirmDelete(`request "${node.request.name}"`))) {
        return;
      }
      controller.collections.deleteRequest(node.request.id);
      controller.closeRequestTab(node.request.id);
    } else if (node.kind === 'folder' && node.folder) {
      if (!(await confirmDelete(`folder "${node.folder.name}"`, ' Requests inside it will also be deleted.'))) {
        return;
      }
      controller.collections.deleteFolder(node.folder.id);
    } else if (node.kind === 'collection' && node.collection) {
      if (!(await confirmDelete(`collection "${node.collection.name}"`, ' All requests inside it will also be deleted.'))) {
        return;
      }
      await controller.collections.deleteCollection(node.collection.id);
    } else if (node.kind === 'environment' && node.environment) {
      if (!(await confirmDelete(`environment "${node.environment.name}"`))) {
        return;
      }
      await controller.environments.delete(node.environment.id);
    } else if (node.kind === 'history' && node.entry) {
      controller.history.remove(node.entry.id);
    }
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.renameNode', async (...args) => {
    const node = nodeArg(args);
    if (!node) {
      return;
    }
    const currentName =
      node.collection?.name ?? node.folder?.name ?? node.request?.name ?? node.environment?.name ?? '';
    const kind = node.kind ?? 'item';
    const name = await vscode.window.showInputBox({
      title: `Rename ${kind}`,
      value: currentName,
      validateInput: (value) => (value.trim() ? undefined : 'The name cannot be empty')
    });
    if (!name || name === currentName) {
      return;
    }
    if (node.collection) {
      controller.collections.updateCollection(node.collection.id, { name });
    } else if (node.folder) {
      controller.collections.updateFolder(node.folder.id, { name });
    } else if (node.request) {
      const request = controller.collections.getRequest(node.request.id);
      if (request) {
        controller.collections.saveRequest({ ...request, name });
      }
      controller.renameOpenRequest(node.request.id, name);
    } else if (node.environment) {
      controller.environments.rename(node.environment.id, name);
    }
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.duplicateNode', async (...args) => {
    const node = nodeArg(args);
    if (!node) {
      return;
    }
    if (node.request) {
      const copy = controller.collections.duplicateRequest(node.request.id);
      if (copy) {
        void vscode.window.showInformationMessage(`Duplicated as "${copy.name}".`);
      }
    } else if (node.collection) {
      controller.collections.duplicateCollection(node.collection.id);
    } else if (node.folder) {
      controller.duplicateFolder(node.folder.id);
    }
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.moveNode', async (...args) => {
    const node = nodeArg(args);
    if (!node?.request) {
      return;
    }
    const request = controller.collections.getRequest(node.request.id);
    if (!request) {
      return;
    }
    const collections = controller.collections.listCollections();
    const targets: { label: string; description: string; collectionId: string; folderId: string | null }[] = [];
    for (const collection of collections) {
      targets.push({ label: collection.name, description: 'Collection root', collectionId: collection.id, folderId: null });
      for (const folder of controller.collections.listFolders(collection.id)) {
        targets.push({
          label: `  ${folder.name}`,
          description: `in ${collection.name}`,
          collectionId: collection.id,
          folderId: folder.id
        });
      }
    }
    const picked = await vscode.window.showQuickPick(targets, {
      title: `Move "${request.name}"`,
      placeHolder: 'Destination',
      matchOnDescription: true
    });
    if (!picked) {
      return;
    }
    controller.collections.moveRequest(request.id, picked.collectionId, picked.folderId);
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.setActiveEnvironment', async (...args) => {
    const node = nodeArg(args);
    if (node?.environment) {
      controller.environments.setActive(node.environment.id);
      sidebar.refresh();
      await controller.broadcastState();
      void vscode.window.showInformationMessage(`Active environment: ${node.environment.name}`);
    }
  });

  register('elyApiClient.clearWebSocketLog', async () => {
    controller.websockets.clearLog();
  });

  // Context menu entries on the tree. Registered with the public command ids used in package.json.
  register('elyApiClient.openRequest', async (...args) => {
    const node = nodeArg(args);
    const id = node?.request?.id ?? (typeof args[0] === 'string' ? args[0] : undefined);
    if (id) {
      await controller.openRequestInPanel(id);
    }
  });

  register('elyApiClient.openEnvironment', async (...args) => {
    const node = nodeArg(args);
    const id = node?.environment?.id ?? (typeof args[0] === 'string' ? args[0] : undefined);
    if (id) {
      await controller.openEnvironmentEditor(id);
    }
  });

  register('elyApiClient.resendHistory', async (...args) => {
    const node = nodeArg(args);
    const id = node?.entry?.id ?? (typeof args[0] === 'string' ? args[0] : undefined);
    if (id) {
      await controller.resendHistory(id);
    }
  });

  register('elyApiClient.internal.selectEnvironment', async () => {
    const environments = controller.environments.list();
    const items = [
      { label: 'No environment', id: null as string | null },
      ...environments.map((environment) => ({
        label: environment.name,
        description: environment.id === controller.environments.getActiveId() ? 'active' : `${environment.variables.length} variables`,
        id: environment.id as string | null
      }))
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Active environment' });
    if (!picked) {
      return;
    }
    controller.environments.setActive(picked.id);
    sidebar.refresh();
    await controller.broadcastState();
  });

  register('elyApiClient.internal.openRequestById', async (id: unknown) => {
    await controller.openRequestInPanel(String(id));
  });

  return disposables;
}

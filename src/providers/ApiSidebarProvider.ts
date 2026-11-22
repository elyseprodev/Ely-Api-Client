import * as vscode from 'vscode';
import type { ApiCollection, ApiEnvironment, ApiFolder, ApiRequest, HistoryEntry } from '../models/types';
import type { ExtensionController } from '../services/ExtensionController';

type TreeNode = CollectionNode | FolderNode | RequestNode | HistoryNode | EnvironmentNode | GroupNode | ToolNode;

interface CollectionNode extends vscode.TreeItem {
  kind: 'collection';
  collection: ApiCollection;
  children: TreeNode[];
}
interface FolderNode extends vscode.TreeItem {
  kind: 'folder';
  folder: ApiFolder;
  children: TreeNode[];
}
interface RequestNode extends vscode.TreeItem {
  kind: 'request';
  request: ApiRequest;
  children: TreeNode[];
}
interface HistoryNode extends vscode.TreeItem {
  kind: 'history';
  entry: HistoryEntry;
  children: TreeNode[];
}
interface EnvironmentNode extends vscode.TreeItem {
  kind: 'environment';
  environment: ApiEnvironment;
  children: TreeNode[];
}
interface GroupNode extends vscode.TreeItem {
  kind: 'group';
  children: TreeNode[];
}
interface ToolNode extends vscode.TreeItem {
  kind: 'tool';
  children: TreeNode[];
}

/**
 * Activity bar explorer: collections/folders/requests, history and environments.
 * The tree is read-only; every mutation is a command so it is undoable/discoverable.
 */
export class ApiSidebarProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly onChange = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.onChange.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly controller: ExtensionController) {
    this.subscription = this.controller.onDidChangeState.event(() => this.onChange.fire(undefined));
  }

  refresh(): void {
    this.onChange.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element) {
      return element.children;
    }
    const collectionNodes = this.buildCollectionNodes();
    const groups: TreeNode[] = [];
    if (collectionNodes.length) {
      groups.push(this.group('collections', 'Collections', collectionNodes, 'folder-library'));
    } else {
      groups.push(this.group('empty-collections', 'Collections', [], 'folder-library'));
    }
    const historyEntries = this.controller.history.list().slice(0, 15);
    groups.push(
      this.group(
        'history',
        'History',
        historyEntries.map((entry) => this.historyNode(entry)),
        'history'
      )
    );
    groups.push(
      this.group(
        'environments',
        'Environments',
        this.controller.environments.list().map((environment) => this.environmentNode(environment)),
        'symbol-namespace'
      )
    );
    groups.push(
      this.group('tools', 'Tools', [this.toolNode()], 'tools')
    );
    return groups;
  }

  private group(id: string, label: string, children: TreeNode[], icon: string): GroupNode {
    const node = new vscode.TreeItem(label, children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None) as GroupNode;
    node.id = `group:${id}`;
    node.kind = 'group';
    node.contextValue = 'ely.group';
    node.iconPath = new vscode.ThemeIcon(icon);
    node.description = String(children.length);
    node.children = children;
    return node;
  }

  private buildCollectionNodes(): TreeNode[] {
    const folders = this.controller.collections.listFolders();
    const requests = this.controller.collections.listRequests();
    return this.controller.collections.listCollections().map((collection) => this.collectionNode(collection, folders, requests));
  }

  private collectionNode(collection: ApiCollection, folders: ApiFolder[], requests: ApiRequest[]): CollectionNode {
    const node = new vscode.TreeItem(collection.name, vscode.TreeItemCollapsibleState.Expanded) as CollectionNode;
    node.kind = 'collection';
    node.collection = collection;
    node.id = `collection:${collection.id}`;
    node.contextValue = 'ely.collection';
    node.iconPath = new vscode.ThemeIcon('folder-library');
    node.description = collection.description || undefined;
    node.tooltip = new vscode.MarkdownString(`**${collection.name}**\n\n${collection.description || '_No description_'}`);
    node.children = [
      ...folders.filter((folder) => folder.collectionId === collection.id && !folder.parentFolderId).map((folder) => this.folderNode(folder, folders, requests)),
      ...requests.filter((request) => request.collectionId === collection.id && !request.folderId).map((request) => this.requestNode(request))
    ];
    return node;
  }

  private folderNode(folder: ApiFolder, folders: ApiFolder[], requests: ApiRequest[]): FolderNode {
    const children = folders.filter((candidate) => candidate.parentFolderId === folder.id);
    const node = new vscode.TreeItem(
      folder.name,
      children.length || requests.some((request) => request.folderId === folder.id)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    ) as FolderNode;
    node.kind = 'folder';
    node.folder = folder;
    node.id = `folder:${folder.id}`;
    node.contextValue = 'ely.folder';
    node.iconPath = new vscode.ThemeIcon('folder');
    node.children = [
      ...children.map((child) => this.folderNode(child, folders, requests)),
      ...requests.filter((request) => request.folderId === folder.id).map((request) => this.requestNode(request))
    ];
    return node;
  }

  private requestNode(request: ApiRequest): RequestNode {
    const node = new vscode.TreeItem(request.name, vscode.TreeItemCollapsibleState.None) as RequestNode;
    node.kind = 'request';
    node.request = request;
    node.id = `request:${request.id}`;
    node.contextValue = 'ely.request';
    node.description = `${request.method} ${request.url ? shortUrl(request.url) : ''}`;
    node.tooltip = new vscode.MarkdownString(`**${request.method}** \`${request.url || '(no URL)'}\``);
    node.iconPath = new vscode.ThemeIcon('arrow-right');
    node.command = { command: 'elyApiClient.openRequest', title: 'Open Request', arguments: [request.id] };
    node.children = [];
    return node;
  }

  private historyNode(entry: HistoryEntry): HistoryNode {
    const hasError = Boolean(entry.error);
    const label = `${entry.method} ${shortUrl(entry.url)}`;
    const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None) as HistoryNode;
    node.kind = 'history';
    node.entry = entry;
    node.id = `history:${entry.id}`;
    node.contextValue = 'ely.history';
    node.description = hasError ? 'failed' : `${entry.statusCode ?? '—'} · ${entry.durationMs ?? 0} ms`;
    node.tooltip = new vscode.MarkdownString(
      `**${entry.method}** \`${entry.url}\`\n\nStatus: ${entry.statusCode ?? 'error'}\n\nDuration: ${entry.durationMs ?? 0} ms`
    );
    node.iconPath = new vscode.ThemeIcon(hasError ? 'error' : statusIcon(entry.statusCode));
    node.command = { command: 'elyApiClient.resendHistory', title: 'Reopen Request', arguments: [entry.id] };
    node.children = [];
    return node;
  }

  private environmentNode(environment: ApiEnvironment): EnvironmentNode {
    const isActive = this.controller.environments.getActiveId() === environment.id;
    const node = new vscode.TreeItem(environment.name, vscode.TreeItemCollapsibleState.None) as EnvironmentNode;
    node.kind = 'environment';
    node.environment = environment;
    node.id = `environment:${environment.id}`;
    node.contextValue = 'ely.environment';
    node.description = `${isActive ? '● active · ' : ''}${environment.variables.length} vars`;
    node.iconPath = new vscode.ThemeIcon(isActive ? 'pass-filled' : 'symbol-namespace');
    node.command = { command: 'elyApiClient.openEnvironment', title: 'Edit Environment', arguments: [environment.id] };
    node.children = [];
    return node;
  }

  private toolNode(): ToolNode {
    const node = new vscode.TreeItem('WebSocket Client', vscode.TreeItemCollapsibleState.None) as ToolNode;
    node.kind = 'tool';
    node.id = 'tool:websocket';
    node.contextValue = 'ely.tool';
    node.iconPath = new vscode.ThemeIcon('radio-tower');
    node.command = { command: 'elyApiClient.openWebSocket', title: 'Open WebSocket Client' };
    node.children = [];
    return node;
  }

  /** Finds any node by id (used by commands that receive tree items). */
  findNode(id: string): CollectionNode | FolderNode | RequestNode | HistoryNode | EnvironmentNode | undefined {
    const visits: TreeNode[] = this.getChildren();
    const queue = [...visits];
    while (queue.length) {
      const node = queue.shift()!;
      if ((node as { id?: string }).id === id) {
        return node as CollectionNode;
      }
      queue.push(...node.children);
    }
    return undefined;
  }

  dispose(): void {
    this.subscription.dispose();
    this.onChange.dispose();
  }
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`.slice(0, 48) || parsed.host;
  } catch {
    return url.slice(0, 48);
  }
}

function statusIcon(status?: number): string {
  if (!status) {
    return 'circle-outline';
  }
  if (status >= 200 && status < 300) {
    return 'pass';
  }
  if (status >= 300 && status < 400) {
    return 'arrow-right';
  }
  return 'warning';
}

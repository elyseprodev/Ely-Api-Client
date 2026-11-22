import type { ApiCollection, ApiEnvironment, ApiFolder, ApiRequest, RunItemResult, RunSummary } from '../models/types';
import type { CollectionService } from './CollectionService';
import type { RequestExecutionService, ExecutionSettings } from './RequestExecutionService';

/**
 * Executes every request in a collection (or a single folder) in tree order and aggregates the
 * per-request test results into one run summary.
 *
 * The runner is deliberately independent of the UI: it takes the same execution pipeline a single
 * send uses, so a batch run cannot drift from an interactive send. Requests run sequentially —
 * that keeps the output deterministic and avoids hammering an API with parallel traffic it was
 * never designed for.
 */

export interface RunCollectionInput {
  collectionId: string;
  /** Expanded into `${workspaceFolder}/…` body file paths. */
  workspaceRoot?: string | null;
  /** Restrict the run to a folder (and its descendants). */
  folderId?: string;
  environment?: ApiEnvironment;
  settings: ExecutionSettings;
  signal?: AbortSignal;
}

export interface RunCollectionDependencies {
  execution: Pick<RequestExecutionService, 'execute'>;
  collections: Pick<
    CollectionService,
    | 'getCollection'
    | 'getFolder'
    | 'listFolders'
    | 'listRequests'
    | 'getCollectionVariables'
    | 'getInheritedHeaders'
    | 'getInheritedTests'
  >;
  /** Called after every finished request so the UI can stream progress. */
  onProgress?: (summary: RunSummary) => void;
}

export class RunAbortedError extends Error {
  constructor() {
    super('Run cancelled.');
    this.name = 'RunAbortedError';
  }
}

/** Folder ids of a folder and everything below it. */
function descendantFolderIds(folders: ApiFolder[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const folder of folders) {
      if (folder.parentFolderId && ids.has(folder.parentFolderId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        added = true;
      }
    }
  }
  return ids;
}

/**
 * Progress is reported frequently and consumed asynchronously, so every notification gets an
 * immutable copy. Handing out the live object made in-flight updates look finished by the time the
 * UI received them.
 */
function snapshot(summary: RunSummary): RunSummary {
  return { ...summary, items: summary.items.slice() };
}

export class CollectionRunner {
  constructor(private readonly deps: RunCollectionDependencies) {}

  /**
   * Requests in the order a human sees them: collection, then folders depth-first, then the
   * requests attached at each level.
   */
  private orderedRequests(collection: ApiCollection, folderId?: string): ApiRequest[] {
    const all = this.deps.collections.listRequests(collection.id);
    if (!folderId) {
      return all;
    }
    const collectionFolders = this.deps.collections.listFolders(collection.id);
    const scope = descendantFolderIds(collectionFolders, folderId);
    // Requests attached at any level of the scoped folder tree, in traversal order.
    const ordered: ApiRequest[] = [];
    const walk = (currentFolderId: string | null) => {
      if (currentFolderId) {
        for (const request of all) {
          if (request.folderId === currentFolderId) {
            ordered.push(request);
          }
        }
      }
      for (const folder of collectionFolders) {
        if (folder.parentFolderId === currentFolderId && scope.has(folder.id)) {
          walk(folder.id);
        }
      }
    };
    walk(folderId);
    return ordered;
  }

  async run(input: RunCollectionInput): Promise<RunSummary> {
    const collection = this.deps.collections.getCollection(input.collectionId);
    if (!collection) {
      throw new Error('Collection not found.');
    }
    const folder = input.folderId ? this.deps.collections.getFolder(input.folderId) : undefined;
    const requests = this.orderedRequests(collection, input.folderId);

    const summary: RunSummary = {
      runId: `run-${Date.now().toString(36)}`,
      collectionId: collection.id,
      collectionName: collection.name,
      folderId: folder ? folder.id : undefined,
      folderName: folder ? folder.name : undefined,
      startedAt: Date.now(),
      finishedAt: undefined,
      status: 'running',
      cancelled: false,
      totalRequests: requests.length,
      passedRequests: 0,
      failedRequests: 0,
      erroredRequests: 0,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      durationMs: 0,
      items: []
    };

    this.deps.onProgress?.(snapshot(summary));

    for (const request of requests) {
      if (input.signal?.aborted) {
        throw new RunAbortedError();
      }
      const itemStarted = Date.now();
      let item: RunItemResult;
      try {
        const result = await this.deps.execution.execute({
          request,
          environment: input.environment,
          collectionVariables: this.deps.collections.getCollectionVariables(request),
          collectionHeaders: this.deps.collections.getInheritedHeaders(request),
          collectionTests: this.deps.collections.getInheritedTests(request),
          settings: input.settings,
          signal: input.signal,
          workspaceRoot: input.workspaceRoot
        });
        item = {
          requestId: request.id,
          name: request.name,
          method: request.method,
          url: result.resolved.url || request.url,
          status: result.response?.status,
          statusText: result.response?.statusText,
          resolved: result.resolved,
          error: result.error,
          tests: result.tests,
          durationMs: result.durationMs
        };
      } catch (error) {
        item = {
          requestId: request.id,
          name: request.name,
          method: request.method,
          url: request.url,
          error: { kind: 'unknown', message: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - itemStarted
        };
      }

      summary.items.push(item);
      if (item.error) {
        summary.erroredRequests += 1;
      } else if ((item.tests?.failed ?? 0) > 0) {
        summary.failedRequests += 1;
      } else {
        summary.passedRequests += 1;
      }
      summary.passedTests += item.tests?.passed ?? 0;
      summary.failedTests += item.tests?.failed ?? 0;
      summary.totalTests = summary.passedTests + summary.failedTests;
      summary.durationMs = Date.now() - summary.startedAt;
      this.deps.onProgress?.(snapshot(summary));
    }

    summary.finishedAt = Date.now();
    summary.durationMs = summary.finishedAt - summary.startedAt;
    summary.status = summary.erroredRequests > 0 || summary.failedRequests > 0 ? 'failed' : 'passed';
    this.deps.onProgress?.(snapshot(summary));
    return summary;
  }

  /** Marks a summary as cancelled; the caller owns the abort signal. */
  static cancel(summary: RunSummary): RunSummary {
    return { ...summary, cancelled: true, status: 'cancelled', finishedAt: Date.now() };
  }
}

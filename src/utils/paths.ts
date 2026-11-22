import * as path from 'node:path';

/**
 * Path helpers for user-selected files (binary bodies, multipart uploads).
 * Absolute paths are accepted as-is; relative paths resolve against the workspace root.
 */

export const WORSPACE_ROOT_PLACEHOLDER = '${workspaceFolder}';

export function resolveUserPath(input: string, workspaceRoot?: string | null): string {
  const trimmed = input.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }
  if (workspaceRoot) {
    return path.normalize(path.join(workspaceRoot, trimmed));
  }
  return path.resolve(trimmed);
}

/** Returns a workspace-relative path when possible so saved requests stay portable. */
export function toPortablePath(absolute: string, workspaceRoot?: string | null): string {
  if (!workspaceRoot) {
    return absolute;
  }
  const relative = path.relative(workspaceRoot, absolute);
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `${WORSPACE_ROOT_PLACEHOLDER}/${relative.split(path.sep).join('/')}`;
  }
  return absolute;
}

export function expandPortablePath(input: string, workspaceRoot?: string | null): string {
  if (!workspaceRoot) {
    return input;
  }
  if (input.startsWith(`${WORSPACE_ROOT_PLACEHOLDER}/`) || input === WORSPACE_ROOT_PLACEHOLDER) {
    return path.join(workspaceRoot, input.slice(WORSPACE_ROOT_PLACEHOLDER.length + 1));
  }
  return input;
}

import * as path from 'node:path';

/**
 * Path helpers for user-selected files (binary bodies, multipart uploads).
 * Absolute paths are accepted as-is; relative paths resolve against the workspace root.
 */

export const WORSPACE_ROOT_PLACEHOLDER = '${workspaceFolder}';

export function resolveUserPath(input: string, workspaceRoot?: string | null): string {
  const trimmed = input.trim().replace(/^~(?=$|\/)/, process.env.HOME ?? '~');
  // A caller that only has the literal placeholder cannot expand it meaningfully; resolving against
  // the process cwd keeps the behaviour of a plain relative path instead of producing a directory
  // literally named `${workspaceFolder}`.
  const root = workspaceRoot === WORSPACE_ROOT_PLACEHOLDER ? process.cwd() : workspaceRoot;
  // `${workspaceFolder}/x` is how a portable path is stored; expanding it here means callers can
  // hand file paths straight from the request document without a separate expansion step.
  const expanded = expandPortablePath(trimmed, root);
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  if (root) {
    return path.normalize(path.join(root, expanded));
  }
  return path.resolve(expanded);
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

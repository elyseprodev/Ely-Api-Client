/**
 * Convenience wrapper around environment variable resolution for whole requests.
 * Lives in `utils` so both services and tests can use it without pulling in VS Code types.
 */

import type { ApiEnvironment, ApiRequest, KeyValueRow } from '../models/types';
import {
  extractVariables,
  resolveVariables,
  scopeFromEnvironment,
  type VariableScope
} from '../models/Environment';

export interface ResolvedText {
  value: string;
  unresolved: string[];
}

export class VariableResolver {
  private scope: VariableScope;
  readonly secretValues: string[];

  constructor(environment?: ApiEnvironment, collectionVariables?: Record<string, string>, runtime?: Record<string, string>) {
    this.scope = scopeFromEnvironment(environment, collectionVariables);
    if (runtime) {
      this.scope.runtime = runtime;
    }
    this.secretValues = Object.values(this.scope.secrets ?? {}).filter((value) => value.length >= 3);
  }

  setRuntimeVariables(runtime: Record<string, string>): void {
    this.scope.runtime = runtime;
  }

  resolve(text: string): ResolvedText {
    if (!text) {
      return { value: text, unresolved: [] };
    }
    const result = resolveVariables(text, this.scope, { keepUnresolved: true });
    return { value: result.value, unresolved: result.unresolved };
  }

  /** Resolves every enabled row's key and value. */
  resolveRows(rows: KeyValueRow[]): { rows: KeyValueRow[]; unresolved: string[] } {
    const unresolved = new Set<string>();
    const rowsOut = rows.map((row) => {
      if (!row.enabled) {
        return row;
      }
      const key = this.resolve(row.key);
      const value = this.resolve(row.value);
      key.unresolved.forEach((name) => unresolved.add(name));
      value.unresolved.forEach((name) => unresolved.add(name));
      return { ...row, key: key.value, value: value.value };
    });
    return { rows: rowsOut, unresolved: [...unresolved] };
  }

  /** Reports variables referenced by a request that no scope can resolve. */
  findUnresolved(request: ApiRequest): string[] {
    const texts = [
      request.url,
      ...request.params.filter((p) => p.enabled).flatMap((p) => [p.key, p.value]),
      ...request.headers.filter((h) => h.enabled).flatMap((h) => [h.key, h.value]),
      request.body.raw,
      ...request.body.form.filter((f) => f.enabled).flatMap((f) => [f.key, f.value]),
      request.auth.token ?? '',
      request.auth.username ?? '',
      request.auth.password ?? '',
      request.auth.keyValue ?? '',
      request.auth.keyName ?? '',
      request.auth.oauth2?.tokenUrl ?? '',
      request.auth.oauth2?.clientId ?? '',
      request.auth.oauth2?.clientSecret ?? '',
      request.auth.oauth2?.scope ?? ''
    ];
    const unresolved = new Set<string>();
    for (const text of texts) {
      for (const name of extractVariables(text)) {
        const { unresolved: missing } = this.resolve(`{{${name}}}`);
        if (missing.includes(name)) {
          unresolved.add(name);
        }
      }
    }
    return [...unresolved];
  }
}

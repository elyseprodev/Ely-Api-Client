import type { ApiEnvironment, EnvironmentVariable } from '../models/types';
import { createEnvironment, normalizeEnvironment } from '../models/Environment';
import { redactEnvironment } from '../models/Request';
import { nowIso } from '../models/Request';
import type { StorageManager } from '../storage/StorageManager';
import type { SecretService } from '../security/SecretStorage';
import type { EmitterLike } from '../models/Emitter';

/**
 * Manages environment profiles and their secret variables.
 *
 * Secret variables are stored twice: the value itself goes to VS Code SecretStorage (key
 * `env:<environmentId>:<variableId>`), and the document keeps the variable with `secret: true` and
 * an empty value. `snapshot()` therefore never leaks secrets to the webview.
 */
export class EnvironmentService {
  private environments: ApiEnvironment[] = [];
  private activeId: string | null = null;

  private readonly changes: EmitterLike<void>;

  constructor(
    private readonly storage: StorageManager,
    private readonly secrets: SecretService,
    onDidChange: EmitterLike<void>
  ) {
    this.changes = onDidChange;
    this.reload();
  }

  get onDidChange(): (listener: (value: void) => void) => { dispose(): unknown } {
    return this.changes.event;
  }

  reload(): void {
    this.environments = this.storage.readEnvironments().map(normalizeEnvironment);
    const active = this.storage.readActiveEnvironmentId();
    this.activeId = active && this.environments.some((env) => env.id === active) ? active : null;
    this.changes.fire();
  }

  list(): ApiEnvironment[] {
    return [...this.environments];
  }

  /** Environments with secret values removed, safe for the webview and exports. */
  snapshot(): ApiEnvironment[] {
    return this.environments.map(redactEnvironment);
  }

  get(id: string): ApiEnvironment | undefined {
    return this.environments.find((env) => env.id === id);
  }

  getActive(): ApiEnvironment | undefined {
    return this.activeId ? this.get(this.activeId) : undefined;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  setActive(id: string | null): void {
    this.activeId = id && this.environments.some((env) => env.id === id) ? id : null;
    this.storage.queueWrite({ activeEnvironmentId: this.activeId }, 0);
    this.changes.fire();
  }

  create(name: string): ApiEnvironment {
    const environment = createEnvironment(this.uniqueName(name));
    this.environments.push(environment);
    this.persist();
    return environment;
  }

  rename(id: string, name: string): ApiEnvironment | undefined {
    const environment = this.get(id);
    if (!environment) {
      return undefined;
    }
    environment.name = this.uniqueName(name, id);
    environment.updatedAt = nowIso();
    this.persist();
    return environment;
  }

  async delete(id: string): Promise<boolean> {
    const environment = this.get(id);
    if (!environment) {
      return false;
    }
    this.environments = this.environments.filter((env) => env.id !== id);
    if (this.activeId === id) {
      this.activeId = null;
      this.storage.queueWrite({ activeEnvironmentId: null }, 0);
    }
    await this.secrets.deleteByPrefix(`env:${id}`);
    this.persist();
    return true;
  }

  async duplicate(id: string): Promise<ApiEnvironment | undefined> {
    const environment = this.get(id);
    if (!environment) {
      return undefined;
    }
    const copy = createEnvironment(this.uniqueName(`${environment.name} (copy)`));
    for (const variable of environment.variables) {
      const cloned: EnvironmentVariable = { ...variable, id: createEnvironment().id };
      if (variable.secret) {
        const secret = await this.secrets.get(this.secretKey(id, variable.id));
        if (secret !== undefined) {
          await this.secrets.store(this.secretKey(copy.id, cloned.id), secret);
        }
      }
      copy.variables.push({ ...cloned, value: variable.secret ? '' : variable.value });
    }
    this.environments.push(copy);
    this.persist();
    return copy;
  }

  /**
   * Saves the variables of an environment. New/changed secret values are written to SecretStorage;
   * secret variables whose value arrives empty keep their existing stored secret.
   */
  async saveVariables(id: string, variables: EnvironmentVariable[]): Promise<ApiEnvironment | undefined> {
    const environment = this.get(id);
    if (!environment) {
      return undefined;
    }
    const previousById = new Map(environment.variables.map((variable) => [variable.id, variable]));
    const next: EnvironmentVariable[] = [];
    for (const variable of variables.slice(0, 500)) {
      const key = (variable.key ?? '').trim();
      if (!key) {
        continue;
      }
      const entry: EnvironmentVariable = {
        id: variable.id || createEnvironment().id,
        key,
        value: typeof variable.value === 'string' ? variable.value : '',
        enabled: variable.enabled !== false,
        secret: Boolean(variable.secret)
      };
      const previous = previousById.get(entry.id);
      if (entry.secret) {
        if (entry.value !== '') {
          await this.secrets.store(this.secretKey(id, entry.id), entry.value);
        } else if (!previous || !previous.secret) {
          await this.secrets.delete(this.secretKey(id, entry.id));
        }
        entry.value = '';
        entry.hasValue = await this.secrets.has(this.secretKey(id, entry.id));
      } else {
        if (previous?.secret) {
          await this.secrets.delete(this.secretKey(id, entry.id));
        }
      }
      next.push(entry);
    }
    // Remove secrets for variables that no longer exist.
    for (const previous of environment.variables) {
      if (previous.secret && !next.some((variable) => variable.id === previous.id)) {
        await this.secrets.delete(this.secretKey(id, previous.id));
      }
    }
    environment.variables = next;
    environment.updatedAt = nowIso();
    this.persist();
    return environment;
  }

  /** Removes the stored secret of a variable while keeping the row. */
  async clearSecret(environmentId: string, variableId: string): Promise<void> {
    await this.secrets.delete(this.secretKey(environmentId, variableId));
    const environment = this.get(environmentId);
    if (environment) {
      const variable = environment.variables.find((v) => v.id === variableId);
      if (variable) {
        variable.hasValue = false;
        variable.value = '';
        environment.updatedAt = nowIso();
        this.persist();
      }
    }
  }

  /**
   * Produces the values for resolution, resolving secret variables from SecretStorage.
   * This map never leaves the extension host.
   */
  async resolveValues(id?: string | null): Promise<Record<string, string>> {
    const environment = id === undefined ? this.getActive() : id ? this.get(id) : undefined;
    if (!environment) {
      return {};
    }
    const values: Record<string, string> = {};
    for (const variable of environment.variables) {
      if (!variable.enabled || !variable.key) {
        continue;
      }
      if (variable.secret) {
        const secret = await this.secrets.get(this.secretKey(environment.id, variable.id));
        if (secret !== undefined) {
          values[variable.key] = secret;
        }
      } else {
        values[variable.key] = variable.value;
      }
    }
    return values;
  }

  /** Marks which secret variables actually have a stored value (for UI badges). */
  async annotateSecrets(environments: ApiEnvironment[]): Promise<ApiEnvironment[]> {
    const annotated: ApiEnvironment[] = [];
    for (const environment of environments) {
      const variables: EnvironmentVariable[] = [];
      for (const variable of environment.variables) {
        if (variable.secret) {
          variables.push({ ...variable, hasValue: await this.secrets.has(this.secretKey(environment.id, variable.id)) });
        } else {
          variables.push(variable);
        }
      }
      annotated.push({ ...environment, variables });
    }
    return annotated;
  }

  /** Stores the values of secret variables (import path). */
  async importSecretValues(environmentId: string, values: Record<string, string>): Promise<void> {
    for (const [variableId, value] of Object.entries(values)) {
      await this.secrets.store(this.secretKey(environmentId, variableId), value);
    }
  }

  async replaceAll(environments: ApiEnvironment[], activeId: string | null): Promise<void> {
    this.environments = environments.map(normalizeEnvironment);
    this.activeId = activeId && this.environments.some((env) => env.id === activeId) ? activeId : null;
    this.persist();
    this.storage.queueWrite({ activeEnvironmentId: this.activeId }, 0);
  }

  secretKey(environmentId: string, variableId: string): string {
    return `env:${environmentId}:${variableId}`;
  }

  private uniqueName(name: string, ignoreId?: string): string {
    const trimmed = (name ?? '').trim() || 'New Environment';
    const existing = this.environments.filter((env) => env.id !== ignoreId).map((env) => env.name);
    if (!existing.includes(trimmed)) {
      return trimmed;
    }
    let counter = 2;
    while (existing.includes(`${trimmed} ${counter}`)) {
      counter++;
    }
    return `${trimmed} ${counter}`;
  }

  private persist(): void {
    this.storage.queueWrite({ environments: this.environments, activeEnvironmentId: this.activeId });
    this.changes.fire();
  }

  flush(): Promise<void> {
    return this.storage.flush({ environments: this.environments, activeEnvironmentId: this.activeId });
  }
}

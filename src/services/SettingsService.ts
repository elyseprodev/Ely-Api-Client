import type { HttpMethod, WebviewSettings } from '../models/types';
import { HTTP_METHODS } from '../models/types';

/**
 * Typed access to the extension's configuration with defensive defaults.
 * Reading through this service means a malformed user setting can never break the client.
 */

export interface ExtensionSettings extends WebviewSettings {
  maxResponseSize: number;
  maxImportSizeBytes: number;
  maxRedirects: number;
  historyRetentionDays: number;
  historyStoreRequestBody: boolean;
  historyRedactSensitiveHeaders: boolean;
  trustedHosts: string[];
  scriptMemoryMb: number;
  storageScope: 'workspace' | 'global';
  websocketHandshakeTimeoutMs: number;
}

export type ConfigurationReader = {
  get<T>(section: string, defaultValue: T): T;
};

const METHOD_SET = new Set<string>(HTTP_METHODS);

export function readSettings(config: ConfigurationReader): ExtensionSettings {
  const num = (key: string, fallback: number, min: number, max: number) => {
    const value = config.get<number>(key, fallback);
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  };
  const bool = (key: string, fallback: boolean) => {
    const value = config.get<boolean>(key, fallback);
    return typeof value === 'boolean' ? value : fallback;
  };
  const enumValue = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = config.get<string>(key, fallback);
    return allowed.includes(value as T) ? (value as T) : fallback;
  };

  const defaultMethod = config.get<string>('request.defaultMethod', 'GET').toUpperCase();
  return {
    defaultMethod: (METHOD_SET.has(defaultMethod) ? defaultMethod : 'GET') as HttpMethod,
    timeout: num('http.timeout', 30000, 0, 600000),
    followRedirects: enumValue('http.followRedirects', ['follow', 'never'] as const, 'follow'),
    maxRedirects: num('http.maxRedirects', 5, 0, 20),
    verifyTls: bool('http.verifyTls', true),
    maxResponseSize: num('http.maxResponseSize', 10 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    maxDisplaySize: num('response.maxDisplaySize', 1024 * 1024, 1024, 64 * 1024 * 1024),
    prettyPrint: bool('response.prettyPrint', true),
    theme: enumValue('ui.theme', ['auto', 'dark', 'light'] as const, 'auto'),
    confirmBeforeDelete: bool('security.confirmBeforeDelete', true),
    historyEnabled: bool('history.enabled', true),
    historyLimit: num('history.limit', 100, 0, 1000),
    historyRetentionDays: num('history.retentionDays', 30, 0, 3650),
    historyStoreRequestBody: bool('history.storeRequestBody', true),
    historyRedactSensitiveHeaders: bool('history.redactSensitiveHeaders', true),
    scriptTimeoutMs: num('testing.timeoutMs', 3000, 100, 30000),
    scriptMemoryMb: num('testing.memoryLimitMb', 32, 8, 256),
    allowPrivateNetwork: bool('security.allowPrivateNetwork', true),
    maxImportSizeBytes: num('security.maxImportSizeBytes', 10 * 1024 * 1024, 1024, 128 * 1024 * 1024),
    websocketMaxMessages: num('websocket.maxMessages', 500, 10, 5000),
    websocketHandshakeTimeoutMs: num('websocket.handshakeTimeoutMs', 15000, 1000, 120000),
    trustedHosts: readStringArray(config, 'security.trustedHosts'),
    storageScope: enumValue('storage.scope', ['workspace', 'global'] as const, 'workspace')
  };
}

function readStringArray(config: ConfigurationReader, key: string): string[] {
  const value = config.get<unknown>(key, []);
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/** The subset of settings the webview needs (no file paths, no limits that reveal internals). */
export function toWebviewSettings(settings: ExtensionSettings): WebviewSettings {
  return {
    defaultMethod: settings.defaultMethod,
    timeout: settings.timeout,
    followRedirects: settings.followRedirects,
    maxRedirects: settings.maxRedirects,
    verifyTls: settings.verifyTls,
    maxDisplaySize: settings.maxDisplaySize,
    prettyPrint: settings.prettyPrint,
    theme: settings.theme,
    confirmBeforeDelete: settings.confirmBeforeDelete,
    historyEnabled: settings.historyEnabled,
    historyLimit: settings.historyLimit,
    scriptTimeoutMs: settings.scriptTimeoutMs,
    allowPrivateNetwork: settings.allowPrivateNetwork,
    websocketMaxMessages: settings.websocketMaxMessages
  };
}

/** Structural subset of VS Code's `WorkspaceConfiguration`. */
export interface ConfigurationLike {
  get<T>(section: string, defaultValue: T): T;
}

/** Reads settings from any `WorkspaceConfiguration`-like object (VS Code or a test double). */
export function readWorkspaceSettings(config: ConfigurationLike): ExtensionSettings {
  return readSettings({
    get: <T>(section: string, defaultValue: T) => {
      try {
        return config.get<T>(section, defaultValue);
      } catch {
        return defaultValue;
      }
    }
  });
}

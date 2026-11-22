/**
 * Minimal VS Code API stub used by the UI harness and the integration tests.
 *
 * Only the APIs that ExtensionController and the providers touch are implemented. The goal is to
 * let the real application logic run in plain Node (no editor download), while keeping behaviour
 * (event emitters, Memento, SecretStorage, Uri) faithful enough to catch integration mistakes.
 *
 * This module is compiled to `out/testing/vscodeStub.js` and is never loaded by the extension host.
 */

export class Emitter<T> {
  private listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class Disposable {
  constructor(private readonly fn: () => void) {}
  static from(...items: { dispose(): void }[]): Disposable {
    return new Disposable(() => items.forEach((item) => item.dispose()));
  }
  dispose(): void {
    this.fn();
  }
}

export class Uri {
  readonly authority = '';
  readonly query = '';
  readonly fragment = '';

  private constructor(
    readonly scheme: string,
    readonly path: string
  ) {}

  toJSON(): { scheme: string; path: string } {
    return { scheme: this.scheme, path: this.path };
  }

  static file(fsPath: string): Uri {
    return new Uri('file', fsPath);
  }

  static parse(value: string): Uri {
    const match = /^([a-zA-Z][\w+.-]*):(.*)$/.exec(value);
    return match ? new Uri(match[1], match[2]) : new Uri('file', value);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ''), ...segments].join('/');
    return new Uri(base.scheme, joined);
  }

  get fsPath(): string {
    return this.path;
  }

  with(changes: { path?: string }): Uri {
    return new Uri(this.scheme, changes.path ?? this.path);
  }

  toString(): string {
    return `${this.scheme}:${this.path}`;
  }
}

export class MemoryMemento {
  private readonly store = new Map<string, unknown>();

  keys(): readonly string[] {
    return [...this.store.keys()];
  }

  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? (this.store.get(key) as T) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, structuredClone(value));
    }
  }
}

export class MemorySecretStorage {
  private readonly values = new Map<string, string>();
  onDidChange = new Emitter<{ key: string }>().event;

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

export class TreeItem {
  children?: unknown[];
  constructor(
    public label: string,
    public collapsibleState?: number
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class ThemeIcon {
  constructor(
    public readonly id: string,
    public readonly color?: unknown
  ) {}
}

export class MarkdownString {
  constructor(public value = '') {}
}

export class EventEmitter<T> extends Emitter<T> {}

export const ViewColumn = { Active: -1, One: 1, Two: 2, Three: 3 };

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };

export class RelativePattern {
  constructor(
    public base: unknown,
    public pattern: string
  ) {}
}

export const StatusBarAlignment = { Left: 1, Right: 2 };

export class ThemeColor {
  constructor(public readonly id: string) {}
}

/** In-memory workspace configuration used when running without an editor. */
export class MemoryConfiguration {
  private readonly values = new Map<string, unknown>();

  constructor(
    private readonly section: string,
    defaults: Record<string, unknown> = {}
  ) {
    for (const [key, value] of Object.entries(defaults)) {
      this.values.set(key, value);
    }
  }

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? (this.values.get(key) as T) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }

  section_(): string {
    return this.section;
  }

  inspect(): undefined {
    return undefined;
  }

  has(key: string): boolean {
    return this.values.has(key);
  }
}

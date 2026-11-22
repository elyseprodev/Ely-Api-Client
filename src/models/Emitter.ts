/**
 * Structural event emitter contract.
 *
 * VS Code's `EventEmitter` satisfies this shape, and so does `SimpleEmitter` in `AppCore`, which
 * lets services run inside the editor and in plain Node (tests, UI harness) without a hard
 * dependency on the `vscode` module.
 */
export interface EmitterLike<T> {
  readonly event: (listener: (value: T) => void) => { dispose(): unknown };
  fire(value: T): void;
  dispose?(): void;
}

export type ListenerLike<T> = (value: T) => void;

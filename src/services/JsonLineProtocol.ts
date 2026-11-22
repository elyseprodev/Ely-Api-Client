/**
 * Minimal JSON-lines transport used between the extension host and the UI harness
 * (`scripts/ui-harness.mjs`). The real extension talks to the webview with postMessage; this module
 * lets the exact same webview bundle run in a browser for screenshots and manual QA.
 *
 * Only used when `process.env.ELY_UI_HARNESS` is set; never active in a normal VS Code session.
 */

export interface HarnessEnvelope {
  id?: number;
  type: string;
  payload?: unknown;
}

export class JsonLineTransport {
  private buffer = '';
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(
    private readonly write: (line: string) => void,
    private readonly onMessage: (message: HarnessEnvelope) => void
  ) {}

  /** Handles a chunk of input (one or more JSON lines). */
  feed(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) {
        this.handleLine(line);
      }
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: HarnessEnvelope;
    try {
      message = JSON.parse(line) as HarnessEnvelope;
    } catch {
      return;
    }
    if (message.type === 'response' && message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.resolve(message.payload);
      }
      return;
    }
    if (message.type === 'error' && message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        pending.reject(new Error(String((message.payload as { message?: string })?.message ?? 'Harness error')));
      }
      return;
    }
    this.onMessage(message);
  }

  send(message: string): void {
    this.write(`${message}\n`);
  }
}

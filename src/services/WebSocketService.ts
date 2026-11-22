import { WebSocket, type RawData } from 'ws';
import type { WebSocketMessage, WebSocketSessionInfo, WebSocketState } from '../models/types';
import { newId } from '../models/Request';
import { validateUrl } from '../utils/UrlValidator';
import { redactSecrets } from '../security/Sanitizer';

/**
 * WebSocket sessions using the `ws` package (supports ws:// and wss://, custom headers and TLS
 * options that the browser WebSocket API cannot express).
 *
 * One session at a time per workspace: connecting again closes the previous socket so users cannot
 * accidentally leave orphaned connections. Messages are bounded by `maxMessages`.
 */

export interface WebSocketConnectOptions {
  url: string;
  headers?: { key: string; value: string }[];
  protocols?: string[];
  verifyTls?: boolean;
  handshakeTimeoutMs?: number;
  maxMessages?: number;
  allowPrivateNetwork?: boolean;
  trustedHosts?: string[];
}

export type WebSocketListener = (session: WebSocketSessionInfo) => void;

const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class WebSocketService {
  private socket: WebSocket | null = null;
  private session: WebSocketSessionInfo | null = null;
  private readonly listeners = new Set<WebSocketListener>();
  private connectTimer: NodeJS.Timeout | undefined;

  onUpdate(listener: WebSocketListener): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  current(): WebSocketSessionInfo | null {
    return this.session;
  }

  private emit(): void {
    if (!this.session) {
      return;
    }
    const snapshot: WebSocketSessionInfo = { ...this.session, messages: [...this.session.messages] };
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // listeners must never break the socket lifecycle
      }
    }
  }

  private setState(state: WebSocketState, extra: Partial<WebSocketSessionInfo> = {}): void {
    if (!this.session) {
      return;
    }
    this.session = { ...this.session, ...extra, state };
    this.emit();
  }

  private pushMessage(message: Omit<WebSocketMessage, 'id' | 'timestamp'> & { timestamp?: number }): void {
    if (!this.session) {
      return;
    }
    const entry: WebSocketMessage = {
      id: newId(),
      direction: message.direction,
      type: message.type,
      data: message.data,
      sizeBytes: message.sizeBytes,
      timestamp: message.timestamp ?? Date.now()
    };
    const limit = this.maxMessages;
    const messages = [...this.session.messages, entry];
    if (messages.length > limit) {
      messages.splice(0, messages.length - limit);
    }
    this.session = { ...this.session, messages };
    this.emit();
  }

  private maxMessages = 500;

  async connect(options: WebSocketConnectOptions): Promise<WebSocketSessionInfo> {
    const validation = validateUrl(options.url, {
      kind: 'websocket',
      allowPrivateNetwork: options.allowPrivateNetwork,
      trustedHosts: options.trustedHosts
    });
    if (!validation.valid || !validation.url) {
      throw new Error(validation.error ?? 'Invalid WebSocket URL.');
    }
    const normalizedUrl = validation.url.toString().replace(/^http(s)?:/, (_match, secure: string | undefined) => (secure ? 'wss:' : 'ws:'));
    if (this.socket) {
      this.disconnect(1000, 'Replaced by a new connection');
    }

    this.maxMessages = Math.max(10, Math.min(5000, options.maxMessages ?? 500));
    this.session = { id: newId(), url: normalizedUrl, state: 'connecting', messages: [] };
    this.emit();

    const socket = new WebSocket(normalizedUrl, options.protocols ?? [], {
      headers: Object.fromEntries((options.headers ?? []).filter((h) => h.key.trim()).map((h) => [h.key, h.value])),
      handshakeTimeout: options.handshakeTimeoutMs ?? 15000,
      rejectUnauthorized: options.verifyTls !== false,
      maxPayload: MAX_MESSAGE_BYTES,
      perMessageDeflate: false
    });
    this.socket = socket;

    if (options.handshakeTimeoutMs) {
      this.connectTimer = setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
          this.setState('error', { error: `The connection was not established within ${options.handshakeTimeoutMs} ms.` });
        }
      }, options.handshakeTimeoutMs + 500);
    }

    socket.on('open', () => {
      if (this.connectTimer) {
        clearTimeout(this.connectTimer);
        this.connectTimer = undefined;
      }
      this.setState('open', { openedAt: Date.now() });
      this.pushMessage({ direction: 'system', type: 'event', data: `Connected to ${normalizedUrl}`, sizeBytes: 0 });
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const text = isBinary ? `«binary ${buffer.length} bytes»` : buffer.toString('utf8');
      this.pushMessage({ direction: 'in', type: isBinary ? 'binary' : 'text', data: text, sizeBytes: buffer.length });
    });

    socket.on('ping', () => {
      this.pushMessage({ direction: 'system', type: 'event', data: 'ping received', sizeBytes: 0 });
    });
    socket.on('pong', () => {
      this.pushMessage({ direction: 'system', type: 'event', data: 'pong received', sizeBytes: 0 });
    });

    socket.on('error', (error) => {
      const message = redactSecrets((error as Error).message || 'WebSocket error');
      this.setState('error', { error: message });
      this.pushMessage({ direction: 'system', type: 'event', data: `Error: ${message}`, sizeBytes: 0 });
    });

    socket.on('close', (code, reason) => {
      if (this.socket === socket) {
        this.socket = null;
      }
      const wasOpen = this.session?.state === 'open';
      this.setState('closed', {
        closedAt: Date.now(),
        closeCode: code,
        closeReason: reason.toString() || undefined,
        error: this.session?.state === 'error' ? this.session?.error : undefined
      });
      this.pushMessage({
        direction: 'system',
        type: 'event',
        data: `${wasOpen ? 'Disconnected' : 'Connection closed'} (code ${code}${reason.toString() ? `, ${reason.toString()}` : ''})`,
        sizeBytes: 0
      });
    });

    return new Promise<WebSocketSessionInfo>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`The connection was not established within ${options.handshakeTimeoutMs ?? 15000} ms.`));
      }, options.handshakeTimeoutMs ?? 15000);

      const onOpen = () => {
        cleanup();
        resolve(this.session!);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new Error(redactSecrets(error.message || 'WebSocket connection failed')));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.off('open', onOpen);
        socket.off('error', onError);
      };
      socket.once('open', onOpen);
      socket.once('error', onError);
    });
  }

  send(text: string): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('The WebSocket is not connected.');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_BYTES) {
      throw new Error('Message exceeds the 8 MB limit.');
    }
    this.socket.send(text);
    this.pushMessage({ direction: 'out', type: 'text', data: text, sizeBytes: Buffer.byteLength(text, 'utf8') });
  }

  disconnect(code = 1000, reason = 'Client disconnected'): void {
    if (!this.socket) {
      return;
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = null;
    this.setState('closing');
    try {
      socket.close(code, reason);
    } catch {
      socket.terminate();
    }
    setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    }, 2000).unref?.();
  }

  clearLog(): void {
    if (!this.session) {
      return;
    }
    this.session = { ...this.session, messages: [] };
    this.emit();
  }

  reset(): void {
    this.disconnect();
    this.session = null;
    this.emit();
  }

  dispose(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = undefined;
    }
    this.socket?.terminate();
    this.socket = null;
    this.listeners.clear();
  }
}

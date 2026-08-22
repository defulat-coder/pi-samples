import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseConnection<TEvent extends { type: string }> {
  /** Writes one named SSE frame; silently drops once the client is gone. */
  send(event: TEvent): void;
  /** Marks the stream finished, stops the heartbeat, and ends the response. */
  close(): void;
  readonly closed: boolean;
  /** Fires when the client disconnects before close(); use it to abort upstream work. */
  onDisconnect(callback: () => void): void;
}

/**
 * Hijacks the reply as an SSE stream with a comment-frame heartbeat so long
 * thinking turns survive proxies. 'aborted' is deprecated since Node 18;
 * 'close' covers disconnects.
 */
export function startSse<TEvent extends { type: string }>(request: FastifyRequest, reply: FastifyReply): SseConnection<TEvent> {
  const raw = reply.raw;
  reply.hijack();
  raw.statusCode = 200;
  raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  raw.setHeader('Cache-Control', 'no-cache, no-transform');
  raw.setHeader('Connection', 'keep-alive');
  raw.setHeader('X-Accel-Buffering', 'no');
  raw.flushHeaders?.();

  let closed = false;
  let finished = false;
  const disconnectCallbacks: (() => void)[] = [];

  const heartbeat = setInterval(() => {
    if (closed || raw.writableEnded || raw.destroyed) return;
    try {
      raw.write(': ping\n\n');
    } catch {
      closed = true;
    }
  }, 15000);

  request.raw.once('close', () => {
    if (finished) return;
    closed = true;
    for (const callback of disconnectCallbacks) callback();
  });

  return {
    send(event) {
      if (closed || raw.writableEnded || raw.destroyed) return;
      try {
        raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    },
    close() {
      finished = true;
      clearInterval(heartbeat);
      if (!raw.writableEnded) raw.end();
    },
    get closed() {
      return closed;
    },
    onDisconnect(callback) {
      disconnectCallbacks.push(callback);
    },
  };
}

import type { Request, Response } from 'express';
import type { StreamMessage } from '../../../shared/types';
import type { AppContext } from '../app';

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events: every store mutation is broadcast so the UI stays
 * live without polling. The client reconnects automatically (EventSource).
 */
export function sseHandler(ctx: AppContext) {
  return (req: Request, res: Response): void => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (message: StreamMessage) => {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    };

    send({ kind: 'hello', system: ctx.systemStatus() });

    const onMessage = (message: StreamMessage) => send(message);
    ctx.store.emitter.on('message', onMessage);

    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on('close', () => {
      clearInterval(heartbeat);
      ctx.store.emitter.off('message', onMessage);
      res.end();
    });
  };
}

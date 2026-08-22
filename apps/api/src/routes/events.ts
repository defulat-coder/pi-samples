import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkbenchEvent } from '@pi-workbench/contracts';
import type { AppContext } from '../context.js';

/** 心跳间隔：25s 一行 `:hb` 注释帧，防止 portless/代理断连。 */
const HEARTBEAT_MS = 25_000;

/**
 * 进程级 SSE 事件总线（GET /api/v1/events）：审批请求等不挂在某个 chat 流上的
 * 事件从这里即时推送，替代前端轮询。客户端集合只持有 raw response，
 * 写失败或连接断开即从集合移除。写法对齐 plugins/sse.ts 的 chat SSE。
 */
export class WorkbenchEventBus {
  private readonly clients = new Map<FastifyReply['raw'], NodeJS.Timeout>();

  /** 接管响应为 SSE 流并登记客户端；hijack 后路由不再返回 payload。 */
  add(request: FastifyRequest, reply: FastifyReply): void {
    const raw = reply.raw;
    reply.hijack();
    raw.statusCode = 200;
    raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    raw.setHeader('Cache-Control', 'no-cache');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders?.();

    const heartbeat = setInterval(() => {
      try {
        raw.write(':hb\n\n');
      } catch {
        this.remove(raw);
      }
    }, HEARTBEAT_MS);
    // 心跳不得阻止进程退出（测试与关闭场景）。
    heartbeat.unref();
    this.clients.set(raw, heartbeat);
    // 断连监听 response 的 close：request 的 'close' 在 Node 18+ 表示请求体读完
    // （GET 连接上几乎立刻触发），会把客户端误移除；response close 才是真的连接终止。
    raw.once('close', () => this.remove(raw));
  }

  private remove(raw: FastifyReply['raw']): void {
    const timer = this.clients.get(raw);
    if (timer === undefined) return;
    clearInterval(timer);
    this.clients.delete(raw);
  }

  /** 向所有已连接客户端广播一帧；写失败的客户端就地移除。 */
  broadcast(event: WorkbenchEvent): void {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const raw of [...this.clients.keys()]) {
      try {
        if (raw.writableEnded || raw.destroyed) {
          this.remove(raw);
          continue;
        }
        raw.write(frame);
      } catch {
        this.remove(raw);
      }
    }
  }

  /** 已连接客户端数（测试与诊断用）。 */
  get clientCount(): number {
    return this.clients.size;
  }

  /** 关闭全部连接并停掉心跳（app onClose 调用）。 */
  close(): void {
    for (const raw of [...this.clients.keys()]) {
      this.remove(raw);
      if (!raw.writableEnded) raw.end();
    }
  }
}

export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/events', (request, reply) => {
    ctx.events.add(request, reply);
  });
}

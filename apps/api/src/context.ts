import type { FastifyReply } from 'fastify';
import { AgentSessionStore, getAgent, SessionBindingError, type WorkbenchDb } from '@pi-workbench/pi-agent';
import type { AppConfig } from './config.js';

/** Shared per-app dependencies handed to every route module. */
export interface AppContext {
  config: AppConfig;
  cwd: string;
  sessions: AgentSessionStore;
  db: WorkbenchDb;
}

export function agentOr404(ctx: AppContext, agentId: string, reply: FastifyReply) {
  try {
    return getAgent(ctx.cwd, agentId);
  } catch {
    reply.code(404).send({ error: `Agent 不存在：${agentId}` });
    return undefined;
  }
}

/** Maps the session-binding contract onto HTTP statuses. */
export async function withOwnedSession<T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SessionBindingError) {
      if (error.code === 'AGENT_SESSION_MISMATCH') {
        reply.code(409).send({ error: '该会话属于另一个 Agent' });
        return undefined;
      }
      if (error.code === 'AGENT_SESSION_NOT_FOUND') {
        reply.code(404).send({ error: '会话不存在' });
        return undefined;
      }
    }
    throw error;
  }
}

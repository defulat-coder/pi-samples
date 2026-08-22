import type { FastifyReply } from 'fastify';
import { AgentSessionStore, ApprovalBridge, getAgent, loadAgents, SessionBindingError, type WorkbenchDb } from '@pi-workbench/pi-agent';
import type { AppConfig } from './config.js';
import type { WorkbenchEventBus } from './routes/events.js';

/** Shared per-app dependencies handed to every route module. */
export interface AppContext {
  config: AppConfig;
  cwd: string;
  sessions: AgentSessionStore;
  db: WorkbenchDb;
  approvalBridge: ApprovalBridge;
  events: WorkbenchEventBus;
}

export function agentOr404(ctx: AppContext, agentId: string, reply: FastifyReply) {
  try {
    return getAgent(ctx.cwd, agentId);
  } catch {
    reply.code(404).send({ error: `Agent 不存在：${agentId}` });
    return undefined;
  }
}

/**
 * 审批扩展在 headless 宿主里取不到 agent 名（请求文件固定 "unknown"）。
 * 输出层按反查到的 agentId 映射真实显示名；SQLite 里保留原值不动。
 * agents 无缓存，每请求构建一次 Map 共享给整个响应。
 */
export function approvalAgentNames(ctx: AppContext): Map<string, string> {
  return new Map(loadAgents(ctx.cwd).map((agent) => [agent.id, agent.name]));
}

/** storedName 是 "unknown" 且 agentId 可解析时，用真实 agent 名覆盖。 */
export function displayAgentName(names: Map<string, string>, agentId: string | undefined, storedName: string): string {
  if (storedName !== 'unknown' || !agentId) return storedName;
  return names.get(agentId) ?? storedName;
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

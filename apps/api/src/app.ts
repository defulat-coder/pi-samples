import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { AgentSessionStore, ApprovalBridge, getPiProjectRoot, openWorkbenchDb, type WorkbenchDb } from '@pi-workbench/pi-agent';
import { loadConfig, type AppConfig } from './config.js';
import { approvalAgentNames, displayAgentName, type AppContext } from './context.js';
import { registerAgentRoutes } from './routes/agents.js';
import { registerApprovalRoutes } from './routes/approvals.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerEventRoutes, WorkbenchEventBus } from './routes/events.js';
import { registerMetaRoutes } from './routes/meta.js';
import { registerPreferenceRoutes } from './routes/preferences.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerUsageRoutes } from './routes/usage.js';

type AppDependencies = { sessionStore?: AgentSessionStore; cwd?: string; db?: WorkbenchDb; approvalBridge?: ApprovalBridge };

export function buildApp(config: AppConfig = loadConfig(), dependencies: AppDependencies = {}): FastifyInstance {
  const cwd = dependencies.cwd ?? getPiProjectRoot();
  const sessions = dependencies.sessionStore ?? new AgentSessionStore({ cwd });
  // Generic workbench data (usage events, preferences) lives in .pi/workbench.db;
  // Pi-specific state stays in Pi's own files.
  const db = dependencies.db ?? openWorkbenchDb(resolve(cwd, '.pi/workbench.db'));
  const events = new WorkbenchEventBus();
  // 审批桥：监听扩展的转发文件树，把 pending 审批落进 SQLite。
  const approvalBridge =
    dependencies.approvalBridge ??
    new ApprovalBridge({ db, cwd, resolveAgentId: async (sessionId) => (await sessions.getSession(sessionId))?.agentId });
  approvalBridge.start();
  const ctx: AppContext = { config, cwd, sessions, db, approvalBridge, events };
  // 审批请求出现即向 SSE 客户端广播（替代轮询延迟）；agentName 套用真实名映射。
  approvalBridge.addPendingListener((approval) => {
    events.broadcast({
      type: 'approval',
      approval: { ...approval, agentName: displayAgentName(approvalAgentNames(ctx), approval.agentId, approval.agentName) },
    });
  });

  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', '*.password', '*.apiKey'] },
    genReqId: () => `req_${crypto.randomUUID().slice(0, 8)}`,
  });

  // Web 走 vite proxy 同源访问，不需要携带凭证的跨域。
  app.register(cors, { origin: config.WEB_ORIGIN });
  app.register(helmet, { contentSecurityPolicy: false });
  app.addHook('onClose', async () => {
    events.close();
    approvalBridge.close();
    db.close();
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'pi-workbench-api', timestamp: new Date().toISOString() }));

  app.register(async (v1) => {
    registerMetaRoutes(v1, ctx);
    registerAgentRoutes(v1, ctx);
    registerSessionRoutes(v1, ctx);
    registerApprovalRoutes(v1, ctx);
    registerEventRoutes(v1, ctx);
    registerPreferenceRoutes(v1, ctx);
    registerUsageRoutes(v1, ctx);
    registerChatRoutes(v1, ctx);
  }, { prefix: '/api/v1' });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: '资源不存在' }));

  app.setErrorHandler((error, request, reply) => {
    const handledError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (handledError.validation) return reply.code(400).send({ error: `请求参数不合法：${handledError.message ?? 'validation failed'}` });
    request.log.error({ err: error });
    const statusCode = handledError.statusCode && handledError.statusCode >= 400 ? handledError.statusCode : 500;
    return reply.code(statusCode).send({ error: '服务暂时无法处理请求' });
  });

  return app;
}

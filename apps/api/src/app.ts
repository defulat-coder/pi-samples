import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Type } from '@sinclair/typebox';
import type { AgentChatRequest, AgentChatStreamEvent, AgentResourceDocument, AgentResourceSummary, WorkspaceRecordQuery } from '@pi-workbench/contracts';
import { loadKnowledgeBundle, searchKnowledge, workspaceStore } from '@pi-workbench/workspace-data';
import { askPiAgent, getPiModelStatus } from '@pi-workbench/pi-agent';
import { loadConfig, type AppConfig } from './config.js';

const WorkspaceRecordQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  search: Type.Optional(Type.String({ maxLength: 200 })),
  kind: Type.Optional(Type.Union([Type.Literal('experiment'), Type.Literal('runbook'), Type.Literal('decision'), Type.Literal('fixture')])),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('draft'), Type.Literal('archived')])),
});

function workspaceResources() {
  return [
    { path: '.pi/skills/pi-workbench/SKILL.md', kind: 'skill' as const, title: 'Pi 工作台智能体技能', status: 'active' as const },
    { path: '.pi/prompts/agent-chat.md', kind: 'prompt' as const, title: '智能体对话提示词', status: 'active' as const },
    ...loadKnowledgeBundle().map((concept) => ({ path: concept.path, kind: 'knowledge' as const, title: concept.title, status: concept.status })),
  ];
}

function readAgentResource(path: string): AgentResourceDocument | undefined {
  const resource = workspaceResources().find((item) => item.path === path) as AgentResourceSummary | undefined;
  if (!resource) return undefined;

  const projectRoots = [resolve(process.cwd()), resolve(process.cwd(), '..'), resolve(process.cwd(), '../..')];
  for (const projectRoot of projectRoots) {
    const absolutePath = resolve(projectRoot, resource.path);
    const relativePath = relative(projectRoot, absolutePath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || relativePath.includes(`${sep}..${sep}`)) continue;
    try {
      return { resource, content: readFileSync(absolutePath, 'utf8') };
    } catch {
      // The API can run from the repository root or from apps/api in tests.
    }
  }
  return undefined;
}

export function buildApp(config: AppConfig = loadConfig()): FastifyInstance {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', '*.password', '*.apiKey'] },
    genReqId: () => `req_${crypto.randomUUID().slice(0, 8)}`,
  });

  app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  app.register(helmet, { contentSecurityPolicy: false });

  app.get('/health', async () => ({ status: 'ok', service: 'pi-workbench-api', timestamp: new Date().toISOString() }));

  app.register(async (v1) => {
    v1.get('/workspace', async () => workspaceStore.getSnapshot(loadKnowledgeBundle().length));

    v1.get<{ Querystring: WorkspaceRecordQuery }>('/workspace/records', { schema: { querystring: WorkspaceRecordQuerySchema } }, async (request) => workspaceStore.listRecords(request.query));

    v1.get<{ Params: { id: string } }>('/workspace/records/:id', { schema: { params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 120 }) }) } }, async (request, reply) => {
      const record = workspaceStore.getRecord(request.params.id);
      if (!record) return reply.code(404).send({ error: 'NotFound', message: '工作区记录不存在' });
      return record;
    });

    v1.get('/agent/workspace', async () => ({
      resources: workspaceResources(),
      tools: { enabled: ['read', 'search_knowledge'], policy: 'read-only' as const },
      model: getPiModelStatus(config.PI_AGENT_ENABLED),
      data: { kind: 'local-sqlite', records: workspaceStore.listRecords({ pageSize: 100 }).total },
    }));

    v1.get<{ Querystring: { path: string } }>('/agent/resource', { schema: { querystring: Type.Object({ path: Type.String({ minLength: 1, maxLength: 400 }) }) } }, async (request, reply) => {
      const document = readAgentResource(request.query.path);
      if (!document) return reply.code(404).send({ error: 'NotFound', message: '项目文件不存在或不在只读资源范围内' });
      return document;
    });

    v1.post<{ Body: AgentChatRequest }>('/agent/chat', { schema: { body: Type.Object({ message: Type.String({ minLength: 1, maxLength: 2000 }), sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), debug: Type.Optional(Type.Boolean()) }) } }, async (request) => {
      const sessionId = request.body.sessionId ?? `session_${crypto.randomUUID().slice(0, 8)}`;
      return askPiAgent(request.body.message, { sessionId, resources: workspaceResources(), searchKnowledge });
    });

    v1.post<{ Body: AgentChatRequest }>('/agent/chat/stream', { schema: { body: Type.Object({ message: Type.String({ minLength: 1, maxLength: 2000 }), sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), debug: Type.Optional(Type.Boolean()) }) } }, async (request, reply) => {
      const sessionId = request.body.sessionId ?? `session_${crypto.randomUUID().slice(0, 8)}`;
      const raw = reply.raw;
      let clientClosed = false;

      reply.hijack();
      raw.statusCode = 200;
      raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      raw.setHeader('Cache-Control', 'no-cache, no-transform');
      raw.setHeader('Connection', 'keep-alive');
      raw.setHeader('X-Accel-Buffering', 'no');
      raw.flushHeaders?.();
      request.raw.once('aborted', () => { clientClosed = true; });

      const send = (eventName: AgentChatStreamEvent['type'], payload: Record<string, unknown>) => {
        if (clientClosed || raw.writableEnded || raw.destroyed) return;
        try {
          raw.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
        } catch {
          clientClosed = true;
        }
      };

      send('start', { sessionId, model: getPiModelStatus(config.PI_AGENT_ENABLED) });
      try {
        let sawTextDelta = false;
        const response = await askPiAgent(request.body.message, { sessionId, resources: workspaceResources(), searchKnowledge }, {
          onEventSummary: (event) => send('event', { event }),
          onTextDelta: (delta) => { if (delta) { sawTextDelta = true; send('text_delta', { delta }); } },
          onThinkingDelta: (delta) => { if (delta) send('thinking_delta', { delta }); },
        });
        if (!sawTextDelta && response.answer) send('text_delta', { delta: response.answer });
        send('done', { response });
      } catch (error) {
        send('error', { message: error instanceof Error ? error.message : '智能体流式响应失败' });
      } finally {
        if (!raw.writableEnded) raw.end();
      }
    });

    v1.get('/knowledge', async () => {
      const concepts = loadKnowledgeBundle();
      return { items: concepts.map(({ body: _body, ...concept }) => concept), total: concepts.length };
    });
    v1.post<{ Body: { prompt: string } }>('/knowledge/search', { schema: { body: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 1000 }) }) } }, async (request) => {
      const items = searchKnowledge(request.body.prompt);
      return { items, total: items.length };
    });
  }, { prefix: '/api/v1' });

  app.setErrorHandler((error, request, reply) => {
    const handledError = error as { validation?: unknown; statusCode?: number };
    if (handledError.validation) return reply.code(400).send({ error: 'ValidationError', message: '请求参数不符合智能体工作台接口约定', requestId: request.id });
    request.log.error({ err: error });
    const statusCode = handledError.statusCode && handledError.statusCode >= 400 ? handledError.statusCode : 500;
    return reply.code(statusCode).send({ error: 'InternalError', message: '服务暂时无法处理请求', requestId: request.id });
  });

  return app;
}

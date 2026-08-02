import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Type } from '@sinclair/typebox';
import type { AgentChatRequest, AgentChatStreamEvent, AgentFeedback, AgentResourceDocument, AgentResourceSummary, WorkspaceRecordQuery } from '@pi-workbench/contracts';
import { loadKnowledgeBundle, searchKnowledge, workspaceStore } from '@pi-workbench/workspace-data';
import { askPiAgent, getPiModelStatus, loadPiResourceSnapshot, piFileSessionStore } from '@pi-workbench/pi-agent';
import type { PiFileSessionStore } from '@pi-workbench/pi-agent';
import { createFeishuAuth } from './auth.js';
import { loadConfig, type AppConfig } from './config.js';

const WorkspaceRecordQuerySchema = Type.Object({
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  search: Type.Optional(Type.String({ maxLength: 200 })),
  kind: Type.Optional(Type.Union([Type.Literal('experiment'), Type.Literal('runbook'), Type.Literal('decision'), Type.Literal('fixture')])),
  status: Type.Optional(Type.Union([Type.Literal('active'), Type.Literal('draft'), Type.Literal('archived')])),
});

type AppDependencies = { sessionStore?: PiFileSessionStore };

function projectRoot() {
  const candidates = [resolve(process.cwd()), resolve(process.cwd(), '..'), resolve(process.cwd(), '../..')];
  return candidates.find((candidate) => existsSync(resolve(candidate, '.pi'))) ?? resolve(process.cwd());
}

function walkPiFiles(directory: string, root = directory): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...walkPiFiles(absolutePath, root));
    else if (entry.isFile()) files.push(relative(root, absolutePath).split(sep).join('/'));
  }
  return files;
}

function inferredResource(path: string): AgentResourceSummary {
  const name = basename(path);
  const extension = extname(name).toLowerCase();
  const kind = path.startsWith('.pi/skills/') ? 'skill' : path.startsWith('.pi/prompts/') ? 'prompt' : path.startsWith('.pi/knowledge/') && extension === '.md' ? 'knowledge' : path.startsWith('.pi/sessions/') ? 'session' : path.startsWith('.pi/extensions/') && ['.ts', '.js', '.mjs', '.cjs'].includes(extension) ? 'extension' : path.startsWith('.pi/themes/') && extension === '.json' ? 'theme' : path === '.pi/settings.json' ? 'settings' : ['.pi/SYSTEM.md', '.pi/APPEND_SYSTEM.md'].includes(path) ? 'system' : 'file';
  const title = path === '.pi/README.md' ? 'Pi 项目说明' : path === '.pi/settings.json' ? 'Pi 项目设置' : path === '.pi/APPEND_SYSTEM.md' ? '追加系统提示词' : path === '.pi/SYSTEM.md' ? '系统提示词' : kind === 'extension' ? `Pi 扩展 · ${name.replace(/\.[^.]+$/, '')}` : kind === 'theme' ? `Pi 主题 · ${name.replace(/\.json$/i, '')}` : kind === 'session' ? `会话 ${name.replace(/^.*_session_/, '').replace(/\.jsonl$/i, '')}` : extension === '.jsonl' ? `运行记录 · ${name.replace(/\.jsonl$/i, '')}` : name.replace(/\.[^.]+$/, '');
  return { path, kind, title, status: 'active' };
}

function workspaceResources(): AgentResourceSummary[] {
  const known = new Map<string, AgentResourceSummary>(loadKnowledgeBundle().map((concept) => [concept.path, { path: concept.path, kind: 'knowledge' as const, title: concept.title, status: concept.status }] as const));
  known.set('.pi/skills/pi-workbench/SKILL.md', { path: '.pi/skills/pi-workbench/SKILL.md', kind: 'skill', title: 'Pi 工作台智能体技能', status: 'active' });
  known.set('.pi/prompts/agent-chat.md', { path: '.pi/prompts/agent-chat.md', kind: 'prompt', title: '智能体对话提示词', status: 'active' });
  return walkPiFiles(resolve(projectRoot(), '.pi'), resolve(projectRoot())).map((path) => known.get(path) ?? inferredResource(path));
}

function readAgentResource(path: string): AgentResourceDocument | undefined {
  const resource = workspaceResources().find((item) => item.path === path) as AgentResourceSummary | undefined;
  if (!resource) return undefined;

  const root = projectRoot();
  const absolutePath = resolve(root, resource.path);
  const relativePath = relative(root, absolutePath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || relativePath.includes(`${sep}..${sep}`)) return undefined;
  try {
    return { resource, content: readFileSync(absolutePath, 'utf8') };
  } catch {
    // A session can be rotated between listing and opening; return a normal 404.
  }
  return undefined;
}

export function buildApp(config: AppConfig = loadConfig(), dependencies: AppDependencies = {}): FastifyInstance {
  const sessions = dependencies.sessionStore ?? piFileSessionStore;
  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', '*.password', '*.apiKey'] },
    genReqId: () => `req_${crypto.randomUUID().slice(0, 8)}`,
  });

  app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  app.register(helmet, { contentSecurityPolicy: false });

  app.get('/health', async () => ({ status: 'ok', service: 'pi-workbench-api', timestamp: new Date().toISOString() }));

  const auth = createFeishuAuth(config);
  const authGuard = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.AUTH_REQUIRED) return;
    if (await auth.getSession(request)) return;
    return reply.code(401).send({ error: 'Unauthenticated', message: '请先使用飞书登录' });
  };

  app.register(async (authRoutes) => {
    authRoutes.get('/status', async (request) => auth.status(request));
    authRoutes.get('/feishu/start', async (_request, reply) => {
      if (!auth.start(reply)) return reply.code(503).send({ error: 'AuthNotConfigured', message: '飞书登录尚未配置，请设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET。' });
      return reply;
    });
    authRoutes.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>('/feishu/callback', {
      schema: { querystring: Type.Object({ code: Type.Optional(Type.String({ maxLength: 2000 })), state: Type.Optional(Type.String({ maxLength: 300 })), error: Type.Optional(Type.String({ maxLength: 200 })), error_description: Type.Optional(Type.String({ maxLength: 500 })) }) },
    }, async (request, reply) => {
      if (request.query.error) {
        auth.clearCookies(reply);
        return reply.redirect(auth.redirectWithError(request.query.error_description ?? request.query.error));
      }
      if (!request.query.code || !request.query.state) {
        auth.clearCookies(reply);
        return reply.redirect(auth.redirectWithError('feishu_callback_missing_code'));
      }
      try {
        await auth.complete(request, reply, request.query.code, request.query.state);
        return reply.redirect(config.WEB_ORIGIN);
      } catch (error) {
        request.log.warn({ err: error instanceof Error ? error.message : 'unknown' }, 'Feishu OAuth callback failed');
        auth.clearCookies(reply);
        return reply.redirect(auth.redirectWithError('feishu_callback_failed'));
      }
    });
    authRoutes.post('/logout', async (request, reply) => auth.logout(request, reply));
  }, { prefix: '/api/v1/auth' });

  app.register(async (v1) => {
    v1.addHook('preHandler', authGuard);
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
      pi: await loadPiResourceSnapshot(projectRoot(), { projectExtensions: config.PI_PROJECT_EXTENSIONS_ENABLED }),
      data: { kind: 'local-sqlite', records: workspaceStore.listRecords({ pageSize: 100 }).total },
      sessions: { kind: 'pi-jsonl', directory: relative(process.cwd(), sessions.sessionDir) || '.' },
    }));

    v1.get('/agent/sessions', async () => {
      const items = await sessions.listSessions();
      return { items, total: items.length };
    });

    v1.post('/agent/sessions', async () => sessions.createSession());

    v1.get<{ Params: { id: string } }>('/agent/sessions/:id', { schema: { params: Type.Object({ id: Type.String({ minLength: 1, maxLength: 120 }) }) } }, async (request, reply) => {
      const session = await sessions.getSession(request.params.id);
      if (!session) return reply.code(404).send({ error: 'NotFound', message: '会话不存在' });
      return session;
    });

    v1.patch<{ Params: { sessionId: string; messageId: string }; Body: { feedback: AgentFeedback | null } }>('/agent/sessions/:sessionId/messages/:messageId/feedback', {
      schema: {
        params: Type.Object({ sessionId: Type.String({ minLength: 1, maxLength: 120 }), messageId: Type.String({ minLength: 1, maxLength: 160 }) }),
        body: Type.Object({ feedback: Type.Union([Type.Literal('like'), Type.Literal('dislike'), Type.Null()]) }),
      },
    }, async (request, reply) => {
      const session = await sessions.setMessageFeedback(request.params.sessionId, request.params.messageId, request.body.feedback);
      if (!session) return reply.code(404).send({ error: 'NotFound', message: '可反馈的智能体消息不存在' });
      return session;
    });

    v1.get<{ Querystring: { path: string } }>('/agent/resource', { schema: { querystring: Type.Object({ path: Type.String({ minLength: 1, maxLength: 400 }) }) } }, async (request, reply) => {
      const document = readAgentResource(request.query.path);
      if (!document) return reply.code(404).send({ error: 'NotFound', message: '项目文件不存在或不在只读资源范围内' });
      return document;
    });

    v1.post<{ Body: AgentChatRequest }>('/agent/chat', { schema: { body: Type.Object({ message: Type.String({ minLength: 1, maxLength: 2000 }), sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), debug: Type.Optional(Type.Boolean()) }) } }, async (request) => {
      const sessionId = request.body.sessionId ?? `session_${crypto.randomUUID().slice(0, 8)}`;
      const turnId = request.body.turnId ?? `turn_${crypto.randomUUID().slice(0, 8)}`;
      await sessions.ensureSession(sessionId);
      const turnNumber = ((await sessions.getSession(sessionId))?.messages.filter((item) => item.kind === 'user').length ?? 0) + 1;
      const response = await askPiAgent(request.body.message, { sessionId, resources: workspaceResources(), searchKnowledge }, { turnNumber });
      if (response.source === 'pi-coding-agent') await sessions.appendTurnMetadata(sessionId, turnId, response, request.body.message);
      else await sessions.appendFallbackTurn(sessionId, request.body.message, turnId, response);
      return response;
    });

    v1.post<{ Body: AgentChatRequest }>('/agent/chat/stream', { schema: { body: Type.Object({ message: Type.String({ minLength: 1, maxLength: 2000 }), sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), turnId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), debug: Type.Optional(Type.Boolean()) }) } }, async (request, reply) => {
      const sessionId = request.body.sessionId ?? `session_${crypto.randomUUID().slice(0, 8)}`;
      const turnId = request.body.turnId ?? `turn_${crypto.randomUUID().slice(0, 8)}`;
      await sessions.ensureSession(sessionId);
      const turnNumber = ((await sessions.getSession(sessionId))?.messages.filter((item) => item.kind === 'user').length ?? 0) + 1;
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
          turnNumber,
          onEventSummary: (event) => send('event', { event }),
          onTextDelta: (delta) => { if (delta) { sawTextDelta = true; send('text_delta', { delta }); } },
          onThinkingDelta: (delta) => { if (delta) send('thinking_delta', { delta }); },
        });
        if (!sawTextDelta && response.answer) send('text_delta', { delta: response.answer });
        if (response.source === 'pi-coding-agent') await sessions.appendTurnMetadata(sessionId, turnId, response, request.body.message);
        else await sessions.appendFallbackTurn(sessionId, request.body.message, turnId, response);
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

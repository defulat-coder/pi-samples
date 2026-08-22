import { existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Type } from '@sinclair/typebox';
import type { AgentThinkingLevel, AgentTemplatesResponse, ChatRequest, ChatStreamEvent, CreateAgentRequest, PreferencesResponse, SessionMessagesResponse, SessionSummary, UsageResponse } from '@pi-workbench/contracts';
import { AGENT_BODY_MAX_BYTES, AGENT_TEMPLATES, AgentCreateError, agentSummary, AgentSessionStore, createAgent, getAgent, getPiModelConfig, getPiProjectRoot, getPiThinkingLevel, getPreferences, listAgentResources, listPrompts, listPiModels, listSkills, loadAgents, openWorkbenchDb, piSessionRegistry, readPrompt, recordUsageEvent, runAgentTurn, setPreference, summarizeTokenUsage, summarizeUsage, type WorkbenchDb } from '@pi-workbench/pi-agent';
import { loadConfig, type AppConfig } from './config.js';

const AgentIdSchema = Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' });
const SessionIdSchema = Type.String({ minLength: 1, maxLength: 120 });
const ThinkingLevelSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);

const ChatRequestSchema = Type.Object({
  agentId: AgentIdSchema,
  sessionId: Type.Optional(SessionIdSchema),
  message: Type.String({ minLength: 1, maxLength: 4000 }),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  thinking: Type.Optional(ThinkingLevelSchema),
});

const PreferenceKeySchema = Type.String({ pattern: '^(ui\\.[a-z-]{1,40}|thinking\\.[a-z][a-z0-9-]{1,63})$' });
const PreferenceUpdateSchema = Type.Object({ key: PreferenceKeySchema, value: Type.Unknown() });

// maxLength counts UTF-16 code units; createAgent re-checks the 32KB byte cap.
const CreateAgentSchema = Type.Object({
  id: Type.Optional(AgentIdSchema),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  mark: Type.String({ minLength: 1, maxLength: 8 }),
  tagline: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1, maxLength: 400 }),
  suggestions: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 1, maxItems: 8 }),
  body: Type.String({ minLength: 1, maxLength: AGENT_BODY_MAX_BYTES }),
});

type AppDependencies = { sessionStore?: AgentSessionStore; cwd?: string; db?: WorkbenchDb };

function projectRoot(): string {
  const candidates = [resolve(process.cwd()), resolve(process.cwd(), '..'), resolve(process.cwd(), '../..')];
  return candidates.find((candidate) => existsSync(resolve(candidate, '.pi'))) ?? getPiProjectRoot();
}

export function buildApp(config: AppConfig = loadConfig(), dependencies: AppDependencies = {}): FastifyInstance {
  const cwd = dependencies.cwd ?? projectRoot();
  const sessions = dependencies.sessionStore ?? new AgentSessionStore({ cwd });
  // Generic workbench data (usage events, preferences) lives in .pi/workbench.db;
  // Pi-specific state stays in Pi's own files.
  const db = dependencies.db ?? openWorkbenchDb(resolve(sessions.sessionDir, '..', 'workbench.db'));

  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', '*.password', '*.apiKey'] },
    genReqId: () => `req_${crypto.randomUUID().slice(0, 8)}`,
  });

  app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  app.register(helmet, { contentSecurityPolicy: false });
  app.addHook('onClose', async () => {
    db.close();
  });

  app.get('/healthz', async () => ({ status: 'ok', service: 'pi-workbench-api', timestamp: new Date().toISOString() }));

  const agentOr404 = (agentId: string, reply: FastifyReply) => {
    try {
      return getAgent(cwd, agentId);
    } catch {
      reply.code(404).send({ error: `Agent 不存在：${agentId}` });
      return undefined;
    }
  };

  /** Maps the session-binding contract onto HTTP statuses. */
  const withOwnedSession = async <T>(reply: FastifyReply, run: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof Error && error.message === 'AGENT_SESSION_MISMATCH') {
        reply.code(409).send({ error: '该会话属于另一个 Agent' });
        return undefined;
      }
      throw error;
    }
  };

  app.register(async (v1) => {
    v1.get('/workspace', async () => ({
      agents: await Promise.all(
        loadAgents(cwd).map(async (agent) => ({
          ...agentSummary(agent),
          sessionCount: (await sessions.listSessions(agent.id)).length,
        })),
      ),
      prompts: listPrompts(cwd),
      models: { current: getPiModelConfig({}, cwd), available: await listPiModels() },
    }));

    v1.get('/skills', async () => {
      const items = listSkills(cwd);
      return { items, total: items.length };
    });

    v1.get('/templates', async (): Promise<AgentTemplatesResponse> => ({ items: [...AGENT_TEMPLATES] }));

    // UI 偏好（ui.* / thinking.<agentId>）持久化在 SQLite；浏览器仍以 localStorage 做即时缓存。
    v1.get('/preferences', async (): Promise<PreferencesResponse> => ({ items: getPreferences(db) }));

    v1.put<{ Body: { key: string; value: unknown } }>('/preferences', { schema: { body: PreferenceUpdateSchema } }, async (request): Promise<PreferencesResponse> => {
      setPreference(db, request.body.key, request.body.value);
      return { items: getPreferences(db) };
    });

    v1.get('/usage', async (): Promise<UsageResponse> => {
      const base = summarizeUsage(await sessions.listSessions(), loadAgents(cwd));
      const tokenSummary = summarizeTokenUsage(db);
      return {
        ...base,
        tokens: { input: tokenSummary.totalInput, output: tokenSummary.totalOutput, total: tokenSummary.totalTokens },
        perAgent: base.perAgent.map((row) => {
          const tokens = tokenSummary.perAgent.find((item) => item.agentId === row.agentId);
          return { ...row, tokens: tokens ? { input: tokens.input, output: tokens.output, total: tokens.total } : { input: 0, output: 0, total: 0 } };
        }),
      };
    });

    // Non-sensitive configuration only; provider keys never leave this process.
    v1.get('/settings', async () => {
      const resources = listAgentResources(cwd);
      return {
        model: { ...getPiModelConfig({}, cwd), available: await listPiModels() },
        thinkingLevel: getPiThinkingLevel(undefined, cwd),
        resources: {
          agents: loadAgents(cwd).length,
          prompts: resources.prompts.length,
          skills: resources.skills.length,
          appendSystem: resources.appendSystem,
        },
        workspace: { name: basename(cwd), sessionDir: relative(cwd, sessions.sessionDir) },
      };
    });

    v1.post<{ Body: CreateAgentRequest }>('/agents', { schema: { body: CreateAgentSchema } }, async (request, reply) => {
      try {
        const agent = createAgent(cwd, request.body);
        return reply.code(201).send(agent);
      } catch (error) {
        if (error instanceof AgentCreateError) {
          return reply.code(error.code === 'CONFLICT' ? 409 : 400).send({ error: error.message });
        }
        throw error;
      }
    });

    v1.get('/inbox', async () => {
      // Inbox = every session whose last recorded run errored or was aborted, newest first.
      const items = (await sessions.listSessions())
        .filter((session) => session.needsAttention)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { items, total: items.length };
    });

    v1.get<{ Params: { agentId: string } }>('/agents/:agentId', { schema: { params: Type.Object({ agentId: AgentIdSchema }) } }, async (request, reply) => {
      const agent = agentOr404(request.params.agentId, reply);
      if (!agent) return;
      return agent;
    });

    v1.get<{ Params: { agentId: string } }>('/agents/:agentId/resources', { schema: { params: Type.Object({ agentId: AgentIdSchema }) } }, async (request, reply) => {
      if (!agentOr404(request.params.agentId, reply)) return;
      const sessionsForAgent = await sessions.listSessions(request.params.agentId);
      return {
        ...listAgentResources(cwd),
        stats: {
          sessionCount: sessionsForAgent.length,
          questionCount: sessionsForAgent.reduce((sum, session) => sum + session.questionCount, 0),
        },
      };
    });

    v1.get<{ Params: { agentId: string } }>('/agents/:agentId/sessions', { schema: { params: Type.Object({ agentId: AgentIdSchema }) } }, async (request, reply) => {
      if (!agentOr404(request.params.agentId, reply)) return;
      const items = await sessions.listSessions(request.params.agentId);
      return { items, total: items.length };
    });

    v1.post<{ Params: { agentId: string } }>('/agents/:agentId/sessions', { schema: { params: Type.Object({ agentId: AgentIdSchema }) } }, async (request, reply) => {
      if (!agentOr404(request.params.agentId, reply)) return;
      return sessions.createSession(request.params.agentId);
    });

    v1.get<{ Params: { agentId: string; sessionId: string } }>('/agents/:agentId/sessions/:sessionId', {
      schema: { params: Type.Object({ agentId: AgentIdSchema, sessionId: SessionIdSchema }) },
    }, async (request, reply) => {
      if (!agentOr404(request.params.agentId, reply)) return;
      const session = await withOwnedSession(reply, () => sessions.getSession(request.params.sessionId, request.params.agentId));
      if (session === undefined && !reply.sent) return reply.code(404).send({ error: '会话不存在' });
      return session;
    });

    v1.get<{ Params: { agentId: string; sessionId: string } }>('/agents/:agentId/sessions/:sessionId/messages', {
      schema: { params: Type.Object({ agentId: AgentIdSchema, sessionId: SessionIdSchema }) },
    }, async (request, reply) => {
      if (!agentOr404(request.params.agentId, reply)) return;
      try {
        const items = await sessions.listMessages(request.params.sessionId, request.params.agentId);
        return { items } satisfies SessionMessagesResponse;
      } catch (error) {
        if (error instanceof Error && error.message === 'AGENT_SESSION_MISMATCH') return reply.code(409).send({ error: '该会话属于另一个 Agent' });
        if (error instanceof Error && error.message === 'AGENT_SESSION_NOT_FOUND') return reply.code(404).send({ error: '会话不存在' });
        throw error;
      }
    });

    v1.patch<{ Params: { agentId: string; sessionId: string }; Body: { title: string } }>('/agents/:agentId/sessions/:sessionId', {
      schema: {
        params: Type.Object({ agentId: AgentIdSchema, sessionId: SessionIdSchema }),
        body: Type.Object({ title: Type.String({ minLength: 1, maxLength: 80 }) }),
      },
    }, async (request, reply) => {
      if (!agentOr404(request.params.agentId, reply)) return;
      const session = await withOwnedSession(reply, () => sessions.renameSession(request.params.sessionId, request.params.agentId, request.body.title));
      if (session === undefined && !reply.sent) return reply.code(404).send({ error: '会话不存在' });
      return session;
    });

    v1.delete<{ Params: { agentId: string; sessionId: string } }>('/agents/:agentId/sessions/:sessionId', {
      schema: { params: Type.Object({ agentId: AgentIdSchema, sessionId: SessionIdSchema }) },
    }, async (request, reply) => {
      if (!agentOr404(request.params.agentId, reply)) return;
      const removed = await withOwnedSession(reply, async () => {
        await piSessionRegistry.close(request.params.agentId, request.params.sessionId);
        return sessions.deleteSession(request.params.sessionId, request.params.agentId);
      });
      if (removed === undefined) return;
      if (!removed) return reply.code(404).send({ error: '会话不存在' });
      return reply.code(204).send();
    });

    v1.get<{ Params: { name: string } }>('/prompts/:name', {
      schema: { params: Type.Object({ name: Type.String({ pattern: '^[a-z0-9-]{1,80}$' }) }) },
    }, async (request, reply) => {
      const document = readPrompt(cwd, request.params.name);
      if (!document) return reply.code(404).send({ error: '提示词不存在' });
      return document;
    });

    v1.post<{ Body: ChatRequest }>('/chat', { schema: { body: ChatRequestSchema } }, async (request, reply) => {
      const agent = agentOr404(request.body.agentId, reply);
      if (!agent) return;

      if (request.body.model) {
        const available = await listPiModels();
        if (!available.some((entry) => entry.id === request.body.model)) {
          return reply.code(400).send({ error: `模型不在可用列表中：${request.body.model}` });
        }
      }

      // Pre-hijack binding validation so cross-agent reuse gets a real 409 response.
      if (request.body.sessionId) {
        try {
          await sessions.getSession(request.body.sessionId, agent.id);
        } catch (error) {
          if (error instanceof Error && error.message === 'AGENT_SESSION_MISMATCH') {
            return reply.code(409).send({ error: '该会话属于另一个 Agent' });
          }
          throw error;
        }
      }

      const thinkingLevel: AgentThinkingLevel = request.body.thinking ?? getPiThinkingLevel(undefined, cwd);
      const modelLabel = { ...getPiModelConfig({}, cwd), ...(request.body.model ? { model: request.body.model } : {}), thinkingLevel };

      const raw = reply.raw;
      let clientClosed = false;
      let finished = false;
      let activeSessionId: string | undefined;
      reply.hijack();
      raw.statusCode = 200;
      raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      raw.setHeader('Cache-Control', 'no-cache, no-transform');
      raw.setHeader('Connection', 'keep-alive');
      raw.setHeader('X-Accel-Buffering', 'no');
      raw.flushHeaders?.();
      // 'aborted' is deprecated since Node 18; 'close' covers disconnects. Once the
      // client is gone we abort the Pi turn instead of burning tokens into the void.
      request.raw.once('close', () => {
        if (finished) return;
        clientClosed = true;
        if (activeSessionId) void piSessionRegistry.abort(agent.id, activeSessionId);
      });

      const send = (event: ChatStreamEvent) => {
        if (clientClosed || raw.writableEnded || raw.destroyed) return;
        try {
          raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          clientClosed = true;
        }
      };
      // Comment-frame heartbeat keeps the stream alive through proxies during long thinking.
      const heartbeat = setInterval(() => {
        if (clientClosed || raw.writableEnded || raw.destroyed) return;
        try {
          raw.write(': ping\n\n');
        } catch {
          clientClosed = true;
        }
      }, 15000);

      // Pi disabled 时不创建空会话：错误事件先于任何 session 持久化。
      if (!config.PI_AGENT_ENABLED) {
        send({ type: 'error', error: 'Pi 模型未启用，无法开始会话' });
        finished = true;
        clearInterval(heartbeat);
        if (!raw.writableEnded) raw.end();
        return;
      }

      // 绑定已在 hijack 前校验过；这里的 MISMATCH 只可能来自并发竞争，按流内错误处理。
      let session: SessionSummary;
      try {
        session = request.body.sessionId
          ? await sessions.ensureSession(request.body.sessionId, agent.id)
          : await sessions.createSession(agent.id);
      } catch (error) {
        send({ type: 'error', error: error instanceof Error && error.message === 'AGENT_SESSION_MISMATCH' ? '该会话属于另一个 Agent' : '会话暂时无法创建' });
        finished = true;
        clearInterval(heartbeat);
        if (!raw.writableEnded) raw.end();
        return;
      }
      activeSessionId = session.id;

      send({ type: 'start', sessionId: session.id, agentId: agent.id, model: modelLabel });
      try {
        const result = await runAgentTurn(agent.id, session.id, request.body.message, {
          thinkingLevel: request.body.thinking,
          ...(request.body.model ? { model: request.body.model } : {}),
          onTextDelta: (delta) => { if (delta) send({ type: 'text_delta', delta }); },
          onThinkingDelta: (delta) => { if (delta) send({ type: 'thinking_delta', delta }); },
          onEvent: (event) => {
            if (event.type === 'auto_retry_start') send({ type: 'retry', attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage });
          },
        });
        send({ type: 'done', answer: result.answer, ...(result.usage ? { usage: result.usage } : {}) });
        if (result.usage) {
          recordUsageEvent(db, { sessionId: session.id, agentId: agent.id, model: modelLabel.model, ...result.usage });
        }
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : '流式响应失败' });
      } finally {
        finished = true;
        clearInterval(heartbeat);
        if (!raw.writableEnded) raw.end();
      }
    });
  }, { prefix: '/api/v1' });

  app.setErrorHandler((error, request, reply) => {
    const handledError = error as { validation?: unknown; statusCode?: number; message?: string };
    if (handledError.validation) return reply.code(400).send({ error: `请求参数不合法：${handledError.message ?? 'validation failed'}` });
    request.log.error({ err: error });
    const statusCode = handledError.statusCode && handledError.statusCode >= 400 ? handledError.statusCode : 500;
    return reply.code(statusCode).send({ error: '服务暂时无法处理请求' });
  });

  return app;
}

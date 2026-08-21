import { existsSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Type } from '@sinclair/typebox';
import type { AgentThinkingLevel, ChatRequest, ChatStreamEvent, CreateAgentRequest } from '@pi-workbench/contracts';
import { AGENT_BODY_MAX_BYTES, AgentCreateError, agentSummary, AgentSessionStore, createAgent, getAgent, getPiModelConfig, getPiProjectRoot, getPiThinkingLevel, listAgentResources, listPrompts, listPiModels, listSkills, loadAgents, piSessionRegistry, readPrompt, runAgentTurn, summarizeUsage } from '@pi-workbench/pi-agent';
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

type AppDependencies = { sessionStore?: AgentSessionStore; cwd?: string };

function projectRoot(): string {
  const candidates = [resolve(process.cwd()), resolve(process.cwd(), '..'), resolve(process.cwd(), '../..')];
  return candidates.find((candidate) => existsSync(resolve(candidate, '.pi'))) ?? getPiProjectRoot();
}

export function buildApp(config: AppConfig = loadConfig(), dependencies: AppDependencies = {}): FastifyInstance {
  const cwd = dependencies.cwd ?? projectRoot();
  const sessions = dependencies.sessionStore ?? new AgentSessionStore({ cwd });

  const app = Fastify({
    logger: { level: config.LOG_LEVEL, redact: ['req.headers.authorization', '*.password', '*.apiKey'] },
    genReqId: () => `req_${crypto.randomUUID().slice(0, 8)}`,
  });

  app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  app.register(helmet, { contentSecurityPolicy: false });

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

    v1.get('/usage', async () => summarizeUsage(await sessions.listSessions(), loadAgents(cwd)));

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

      const session = await withOwnedSession(reply, () =>
        request.body.sessionId
          ? sessions.ensureSession(request.body.sessionId, agent.id)
          : sessions.createSession(agent.id),
      );
      if (session === undefined) return;

      const thinkingLevel: AgentThinkingLevel = request.body.thinking ?? getPiThinkingLevel(undefined, cwd);
      const modelLabel = { ...getPiModelConfig({}, cwd), ...(request.body.model ? { model: request.body.model } : {}), thinkingLevel };

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

      const send = (event: ChatStreamEvent) => {
        if (clientClosed || raw.writableEnded || raw.destroyed) return;
        try {
          raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        } catch {
          clientClosed = true;
        }
      };

      send({ type: 'start', sessionId: session.id, agentId: agent.id, model: modelLabel });
      try {
        if (!config.PI_AGENT_ENABLED) throw new Error('Pi 模型未启用，无法开始会话');
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
      } catch (error) {
        send({ type: 'error', error: error instanceof Error ? error.message : '流式响应失败' });
      } finally {
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

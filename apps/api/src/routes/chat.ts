import type { FastifyInstance } from 'fastify';
import type { AgentThinkingLevel, ChatRequest, ChatStreamEvent, SessionSummary } from '@pi-workbench/contracts';
import { getPiModelConfig, getPiThinkingLevel, listPiModels, piSessionRegistry, recordUsageEvent, runAgentTurn, SessionBindingError } from '@pi-workbench/pi-agent';
import { ChatRequestSchema } from '../schemas.js';
import { agentOr404, type AppContext } from '../context.js';
import { startSse } from '../plugins/sse.js';

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post<{ Body: ChatRequest }>('/chat', { schema: { body: ChatRequestSchema } }, async (request, reply) => {
    const agent = agentOr404(ctx, request.body.agentId, reply);
    if (!agent) return;

    if (request.body.model) {
      const available = await listPiModels(ctx.cwd);
      if (!available.some((entry) => entry.id === request.body.model)) {
        return reply.code(400).send({ error: `模型不在可用列表中：${request.body.model}` });
      }
    }

    // Pre-hijack binding validation so cross-agent reuse gets a real 409 response.
    if (request.body.sessionId) {
      try {
        await ctx.sessions.getSession(request.body.sessionId, agent.id);
      } catch (error) {
        if (error instanceof SessionBindingError && error.code === 'AGENT_SESSION_MISMATCH') {
          return reply.code(409).send({ error: '该会话属于另一个 Agent' });
        }
        throw error;
      }
    }

    const thinkingLevel: AgentThinkingLevel = request.body.thinking ?? getPiThinkingLevel(undefined, ctx.cwd);
    const modelLabel = { ...getPiModelConfig({}, ctx.cwd), ...(request.body.model ? { model: request.body.model } : {}), thinkingLevel };

    const sse = startSse<ChatStreamEvent>(request, reply);

    // Pi disabled 时不创建空会话：错误事件先于任何 session 持久化。
    if (!ctx.config.PI_AGENT_ENABLED) {
      sse.send({ type: 'error', error: 'Pi 模型未启用，无法开始会话' });
      sse.close();
      return;
    }

    // 绑定已在 hijack 前校验过；这里的 MISMATCH 只可能来自并发竞争，按流内错误处理。
    let session: SessionSummary;
    try {
      session = request.body.sessionId
        ? await ctx.sessions.ensureSession(request.body.sessionId, agent.id)
        : await ctx.sessions.createSession(agent.id);
    } catch (error) {
      const mismatch = error instanceof SessionBindingError && error.code === 'AGENT_SESSION_MISMATCH';
      sse.send({ type: 'error', error: mismatch ? '该会话属于另一个 Agent' : '会话暂时无法创建' });
      sse.close();
      return;
    }
    // Once the client is gone we abort the Pi turn instead of burning tokens into the void.
    sse.onDisconnect(() => {
      void piSessionRegistry.abort(agent.id, session.id);
    });
    sse.send({ type: 'start', sessionId: session.id, agentId: agent.id, model: modelLabel });
    try {
      const result = await runAgentTurn(agent.id, session.id, request.body.message, {
        thinkingLevel: request.body.thinking,
        ...(request.body.model ? { model: request.body.model } : {}),
        onTextDelta: (delta) => { if (delta) sse.send({ type: 'text_delta', delta }); },
        onThinkingDelta: (delta) => { if (delta) sse.send({ type: 'thinking_delta', delta }); },
        onEvent: (event) => {
          if (event.type === 'auto_retry_start') sse.send({ type: 'retry', attempt: event.attempt, maxAttempts: event.maxAttempts, errorMessage: event.errorMessage });
        },
      });
      sse.send({ type: 'done', answer: result.answer, ...(result.usage ? { usage: result.usage } : {}) });
      if (result.usage) {
        recordUsageEvent(ctx.db, { sessionId: session.id, agentId: agent.id, model: modelLabel.model, ...result.usage });
      }
    } catch (error) {
      sse.send({ type: 'error', error: error instanceof Error ? error.message : '流式响应失败' });
    } finally {
      sse.close();
    }
  });
}

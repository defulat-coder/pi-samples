import type { FastifyInstance } from 'fastify';
import type { InboxResponse, RenameSessionRequest, SessionListResponse, SessionMessagesResponse } from '@pi-workbench/contracts';
import { piSessionRegistry } from '@pi-workbench/pi-agent';
import { AgentParamsSchema, RenameSessionSchema, SessionParamsSchema } from '../schemas.js';
import { agentOr404, withOwnedSession, type AppContext } from '../context.js';

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/inbox', async (): Promise<InboxResponse> => {
    // Inbox = every session whose last recorded run errored or was aborted, newest first.
    const items = (await ctx.sessions.listSessions())
      .filter((session) => session.needsAttention)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { items, total: items.length };
  });

  app.get<{ Params: { agentId: string } }>('/agents/:agentId/sessions', { schema: { params: AgentParamsSchema } }, async (request, reply): Promise<SessionListResponse | undefined> => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    const items = await ctx.sessions.listSessions(request.params.agentId);
    return { items, total: items.length };
  });

  app.post<{ Params: { agentId: string } }>('/agents/:agentId/sessions', { schema: { params: AgentParamsSchema } }, async (request, reply) => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    return ctx.sessions.createSession(request.params.agentId);
  });

  app.get<{ Params: { agentId: string; sessionId: string } }>('/agents/:agentId/sessions/:sessionId', {
    schema: { params: SessionParamsSchema },
  }, async (request, reply) => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    const session = await withOwnedSession(reply, () => ctx.sessions.getSession(request.params.sessionId, request.params.agentId));
    if (session === undefined && !reply.sent) return reply.code(404).send({ error: '会话不存在' });
    return session;
  });

  app.get<{ Params: { agentId: string; sessionId: string } }>('/agents/:agentId/sessions/:sessionId/messages', {
    schema: { params: SessionParamsSchema },
  }, async (request, reply) => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    const items = await withOwnedSession(reply, () => ctx.sessions.listMessages(request.params.sessionId, request.params.agentId));
    if (items === undefined) return;
    return { items } satisfies SessionMessagesResponse;
  });

  app.patch<{ Params: { agentId: string; sessionId: string }; Body: RenameSessionRequest }>('/agents/:agentId/sessions/:sessionId', {
    schema: { params: SessionParamsSchema, body: RenameSessionSchema },
  }, async (request, reply) => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    const session = await withOwnedSession(reply, () => ctx.sessions.renameSession(request.params.sessionId, request.params.agentId, request.body.title));
    if (session === undefined && !reply.sent) return reply.code(404).send({ error: '会话不存在' });
    return session;
  });

  app.delete<{ Params: { agentId: string; sessionId: string } }>('/agents/:agentId/sessions/:sessionId', {
    schema: { params: SessionParamsSchema },
  }, async (request, reply) => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    const removed = await withOwnedSession(reply, async () => {
      await piSessionRegistry.close(request.params.agentId, request.params.sessionId);
      return ctx.sessions.deleteSession(request.params.sessionId, request.params.agentId);
    });
    if (removed === undefined) return;
    if (!removed) return reply.code(404).send({ error: '会话不存在' });
    return reply.code(204).send();
  });
}

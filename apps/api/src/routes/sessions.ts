import type { FastifyInstance } from 'fastify';
import type {
  InboxItem,
  InboxResponse,
  InboxTab,
  PendingApproval,
  RenameSessionRequest,
  SessionListResponse,
  SessionMessagesResponse,
  SessionSummary,
  UpdateInboxStateRequest,
} from '@pi-workbench/contracts';
import { deleteInboxState, getInboxStates, piSessionRegistry, setInboxCompleted, setInboxRead, type InboxState, type StoredApproval } from '@pi-workbench/pi-agent';
import { AgentParamsSchema, InboxQuerySchema, RenameSessionSchema, SessionParamsSchema, UpdateInboxStateSchema } from '../schemas.js';
import { agentOr404, withOwnedSession, type AppContext } from '../context.js';

/** 已读判定：read_at 不早于会话最后更新时间（ISO 字符串可直接比较）。 */
function isRead(session: SessionSummary, state: InboxState | undefined): boolean {
  return Boolean(state?.readAt && state.readAt >= session.updatedAt);
}

/** StoredApproval → 合同 PendingApproval（剥掉 nonce/targetSessionId 等传输字段）。 */
function toPendingApproval(approval: StoredApproval): PendingApproval {
  return {
    id: approval.id,
    sessionId: approval.sessionId,
    ...(approval.agentId ? { agentId: approval.agentId } : {}),
    agentName: approval.agentName,
    message: approval.message,
    createdAt: approval.createdAt,
  };
}

function toInboxItem(session: SessionSummary, state: InboxState | undefined, pendingApproval?: StoredApproval): InboxItem {
  const completedAt = state?.completedAt ?? undefined;
  return {
    ...session,
    read: isRead(session, state),
    ...(completedAt ? { completedAt } : {}),
    ...(pendingApproval ? { pendingApproval: toPendingApproval(pendingApproval) } : {}),
  };
}

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { tab?: InboxTab; q?: string } }>('/inbox', { schema: { querystring: InboxQuerySchema } }, async (request): Promise<InboxResponse> => {
    const tab = request.query.tab ?? 'attention';
    const query = request.query.q?.trim().toLowerCase();
    const sessions = await ctx.sessions.listSessions();
    let states = getInboxStates(ctx.db);
    // 有待审批工具调用的会话并入 attention（不动 needsAttention 的 JSONL 推导逻辑）。
    const pendingApprovals = ctx.approvalBridge.pendingBySession();

    // 自动完成：曾进过收件箱（有 inbox_state 记录）、尚未完成，且最新一轮已成功。
    let changed = false;
    for (const session of sessions) {
      const state = states.get(session.id);
      if (state && !state.completedAt && !session.needsAttention && !pendingApprovals.has(session.id)) {
        setInboxCompleted(ctx.db, session.id, session.agentId, true);
        changed = true;
      }
    }
    if (changed) states = getInboxStates(ctx.db);

    const inTab = sessions.filter((session) => {
      const completed = Boolean(states.get(session.id)?.completedAt);
      const attention = (session.needsAttention || pendingApprovals.has(session.id)) && !completed;
      if (tab === 'attention') return attention;
      if (tab === 'completed') return completed;
      return attention || completed;
    });
    // unreadCount 始终按 attention 集合统计，不受 tab/q 影响。
    const unreadCount = sessions.filter((session) => session.needsAttention && !states.get(session.id)?.completedAt && !isRead(session, states.get(session.id))).length;
    const filtered = query ? inTab.filter((session) => session.title.toLowerCase().includes(query) || (session.preview ?? '').toLowerCase().includes(query)) : inTab;
    const items = filtered
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => toInboxItem(session, states.get(session.id), pendingApprovals.get(session.id)));
    return { items, total: items.length, unreadCount };
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
    // rename 向同一 JSONL append，必须与进行中的 turn 共用一个 per-key 串行队列，
    // 避免与 registry 持有的 SessionManager 并发写交错；排在 in-flight turn 之后执行。
    const session = await withOwnedSession(reply, () =>
      piSessionRegistry.runExclusive(request.params.agentId, request.params.sessionId, () =>
        ctx.sessions.renameSession(request.params.sessionId, request.params.agentId, request.body.title)));
    if (session === undefined && !reply.sent) return reply.code(404).send({ error: '会话不存在' });
    return session;
  });

  app.patch<{ Params: { agentId: string; sessionId: string }; Body: UpdateInboxStateRequest }>('/agents/:agentId/sessions/:sessionId/inbox', {
    schema: { params: SessionParamsSchema, body: UpdateInboxStateSchema },
  }, async (request, reply) => {
    if (!agentOr404(ctx, request.params.agentId, reply)) return;
    // 只写 SQLite 的 inbox_state，不触碰 JSONL，无需进入 per-session 串行队列。
    const session = await withOwnedSession(reply, () => ctx.sessions.getSession(request.params.sessionId, request.params.agentId));
    if (session === undefined && !reply.sent) return reply.code(404).send({ error: '会话不存在' });
    if (!session) return;
    // completed 先应用：其「顺带标记已读」不应覆盖本次请求里显式的 read。
    if (request.body.completed !== undefined) setInboxCompleted(ctx.db, session.id, session.agentId, request.body.completed);
    if (request.body.read !== undefined) setInboxRead(ctx.db, session.id, session.agentId, request.body.read);
    // 不在收件箱任一集合的会话也照常返回最新状态字段。
    return toInboxItem(session, getInboxStates(ctx.db).get(session.id));
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
    deleteInboxState(ctx.db, request.params.sessionId);
    return reply.code(204).send();
  });
}

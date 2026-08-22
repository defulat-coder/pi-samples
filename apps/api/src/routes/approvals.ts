import type { FastifyInstance } from 'fastify';
import type { ApprovalDecisionRequest, ApprovalListResponse, ApprovalRecord, ApprovalState } from '@pi-workbench/contracts';
import { ApprovalError, listApprovals, type StoredApproval } from '@pi-workbench/pi-agent';
import { ApprovalDecisionSchema, ApprovalParamsSchema, ApprovalQuerySchema } from '../schemas.js';
import { approvalAgentNames, displayAgentName, type AppContext } from '../context.js';

/** responseNonce/targetSessionId 是回写扩展的传输细节，从 API 响应里剥掉。 */
function toApprovalRecord(stored: StoredApproval, names: Map<string, string>): ApprovalRecord {
  return {
    id: stored.id,
    sessionId: stored.sessionId,
    ...(stored.agentId ? { agentId: stored.agentId } : {}),
    agentName: displayAgentName(names, stored.agentId, stored.agentName),
    message: stored.message,
    state: stored.state,
    createdAt: stored.createdAt,
    ...(stored.resolvedAt ? { resolvedAt: stored.resolvedAt } : {}),
  };
}

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  // 审批是进程级事件，不挂在某个 chat SSE 流上：Web 侧轮询本端点（配合 inbox 刷新触发）。
  app.get<{ Querystring: { state?: ApprovalState } }>('/approvals', { schema: { querystring: ApprovalQuerySchema } }, async (request): Promise<ApprovalListResponse> => {
    const names = approvalAgentNames(ctx);
    const items = listApprovals(ctx.db, request.query.state).map((stored) => toApprovalRecord(stored, names));
    return { items, total: items.length };
  });

  app.post<{ Params: { id: string }; Body: ApprovalDecisionRequest }>('/approvals/:id/decision', {
    schema: { params: ApprovalParamsSchema, body: ApprovalDecisionSchema },
  }, async (request, reply) => {
    try {
      return toApprovalRecord(ctx.approvalBridge.respond(request.params.id, request.body), approvalAgentNames(ctx));
    } catch (error) {
      if (error instanceof ApprovalError) {
        if (error.code === 'APPROVAL_NOT_FOUND') return reply.code(404).send({ error: '审批不存在' });
        return reply.code(409).send({ error: '审批已被处理' });
      }
      throw error;
    }
  });
}

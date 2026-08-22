import { useState } from 'react';
import type { ApprovalDecisionRequest, PendingApproval } from '@pi-workbench/contracts';
import { ShieldCheck } from '@phosphor-icons/react/dist/icons/ShieldCheck';
import { decideApproval } from '../lib/api.js';
import { formatRelativeTime } from '../lib/sessions.js';
import { useWorkspace } from '../context/WorkspaceContext.js';

/**
 * HITL 工具审批卡片：Fleet 中断卡片（Authenticate）模式的本地等价物。
 * 批准 / 始终允许（仅当前运行会话内有效）/ 带理由拒绝；10 分钟未处理后端自动过期。
 */
export function ApprovalCard({ approval, agentName, onSettled }: {
  approval: PendingApproval;
  /** 工作区反查的 Agent 名；approval.agentName 为空时兜底。 */
  agentName: string;
  /** 决策落定（成功或 409 已处理）后调用，由父级刷新收件箱让卡片消失。 */
  onSettled: () => void;
}) {
  const { notify } = useWorkspace();
  const [submitting, setSubmitting] = useState(false);
  /** 拒绝是两步：先展开理由输入（可留空），再确认提交。 */
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');

  const decide = async (decision: ApprovalDecisionRequest, successText: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await decideApproval(approval.id, decision);
      notify(successText);
      onSettled();
    } catch (error) {
      const message = error instanceof Error ? error.message : '审批操作暂时无法提交';
      if (message === '该审批已被处理') {
        notify('该审批已被处理或已过期');
        onSettled();
      } else {
        notify(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const trimmedReason = reason.trim();

  return (
    <div className="approval-card" role="region" aria-label="审批请求">
      <div className="approval-card-head">
        <ShieldCheck size={16} weight="fill" aria-hidden="true" />
        <span className="approval-card-title">审批请求</span>
        <span className="approval-card-agent">{approval.agentName || agentName}</span>
        <span className="approval-card-time">{formatRelativeTime(approval.createdAt, new Date())}</span>
      </div>
      <p className="approval-card-message">{approval.message}</p>
      <p className="approval-card-hint">10 分钟内未处理将过期</p>
      {denying ? (
        <div className="approval-card-deny">
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="拒绝理由（可选）"
            aria-label="拒绝理由"
            autoFocus
          />
          <button
            type="button"
            className="header-button danger"
            disabled={submitting}
            onClick={() => void decide({ approved: false, ...(trimmedReason ? { reason: trimmedReason } : {}) }, '已拒绝')}
          >
            确认拒绝
          </button>
          <button type="button" className="header-button" disabled={submitting} onClick={() => setDenying(false)}>
            取消
          </button>
        </div>
      ) : (
        <div className="approval-card-actions">
          <button
            type="button"
            className="header-button primary"
            disabled={submitting}
            onClick={() => void decide({ approved: true }, '已批准')}
          >
            批准
          </button>
          <button
            type="button"
            className="header-button"
            title="写入项目权限策略，长期生效"
            disabled={submitting}
            onClick={() => void decide({ approved: true, always: true }, '已批准，该命令已写入项目权限策略，后续自动放行')}
          >
            始终允许
          </button>
          <button type="button" className="header-button danger" disabled={submitting} onClick={() => setDenying(true)}>
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}

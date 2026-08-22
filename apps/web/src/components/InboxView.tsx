import { AnimatePresence, motion } from 'motion/react';
import type { AgentSummary, SessionSummary } from '@pi-workbench/contracts';
import { ArrowClockwise } from '@phosphor-icons/react/dist/icons/ArrowClockwise';
import { Tray } from '@phosphor-icons/react/dist/icons/Tray';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { formatRelativeTime, sortSessions } from '../lib/sessions.js';
import { MOTION_EASE } from '../lib/motion.js';
import { AgentChip } from './AgentChip.js';

function attentionLabel(session: SessionSummary): string {
  return session.attentionReason === 'aborted' ? '已中断' : '出错';
}

export type InboxViewProps = {
  items: SessionSummary[];
  agents: AgentSummary[];
  loading: boolean;
  onRefresh: () => void;
  onOpen: (agentId: string, sessionId: string) => void;
};

export function InboxView({ items, agents, loading, onRefresh, onOpen }: InboxViewProps) {
  const agentName = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const agentMark = (agentId: string) => agents.find((agent) => agent.id === agentId)?.mark ?? '?';
  const rows = sortSessions(items);
  const now = new Date();

  return (
    <div className="inbox">
      <div className="inbox-header">
        <Tray size={20} aria-hidden="true" />
        <h3>收件箱</h3>
      </div>

      <div className="inbox-toolbar">
        <button type="button" className="inbox-refresh" onClick={onRefresh} aria-label="刷新收件箱" disabled={loading}>
          <ArrowClockwise size={16} />
        </button>
        <span className="inbox-count">{loading ? '刷新中…' : `${rows.length} 个会话`}</span>
      </div>

      {!rows.length && !loading ? (
        <div className="inbox-empty">
          <Tray size={28} aria-hidden="true" />
          <p className="inbox-empty-title">没有需要处理的会话</p>
          <p className="inbox-empty-hint">运行出错或被中断的会话会出现在这里。</p>
        </div>
      ) : (
        <div className="inbox-list" role="list">
          <AnimatePresence initial={false}>
            {rows.map((session) => (
              <motion.button
                type="button"
                role="listitem"
                key={session.id}
                className="inbox-row"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: -8, transition: { duration: 0.15, ease: MOTION_EASE } }}
                whileTap={{ scale: 0.97 }}
                transition={{ duration: 0.2, ease: MOTION_EASE }}
                onClick={() => onOpen(session.agentId, session.id)}
                title={session.attentionDetail ?? session.title}
              >
                <AgentChip mark={agentMark(session.agentId)} />
                <span className="inbox-agent">{agentName(session.agentId)}</span>
                <span className="inbox-status">
                  <WarningCircle size={12} weight="fill" aria-hidden="true" />
                  {attentionLabel(session)}
                </span>
                <span className="inbox-title">{session.title}</span>
                <span className="inbox-time">{formatRelativeTime(session.updatedAt, now)}</span>
              </motion.button>
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

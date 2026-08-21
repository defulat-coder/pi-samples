import { motion } from 'motion/react';
import type { AgentSummary } from '@pi-workbench/contracts';
import { agentCardStats } from '../lib/explore.js';

const motionEase = [0.23, 1, 0.32, 1] as const;

export type ExploreAgentsProps = {
  agents: AgentSummary[];
  onOpenChat: (agentId: string) => void;
};

/** 工作区 Agents 页：卡片样式类推 §11.4（原页是付费墙，无真实列表可抓）。 */
export function ExploreAgents({ agents, onOpenChat }: ExploreAgentsProps) {
  return (
    <div className="explore">
      <header className="explore-header">
        <h1>Agents</h1>
        <p>工作区里的全部 Agent，共 {agents.length} 个。点击卡片开始聊天。</p>
      </header>

      <div className="explore-grid" role="list">
        {agents.map((agent, index) => {
          const stats = agentCardStats(agent);
          return (
            <motion.button
              type="button"
              role="listitem"
              key={agent.id}
              className="agent-card"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: motionEase, delay: index * 0.04 }}
              onClick={() => onOpenChat(agent.id)}
            >
              <span className="agent-card-head">
                <span className="agent-chip medium" aria-hidden="true">{agent.mark.slice(0, 2)}</span>
                <span className="agent-card-title">
                  <strong>{agent.name}</strong>
                  <small>{agent.tagline}</small>
                </span>
              </span>
              <span className="agent-card-desc">{agent.description}</span>
              <span className="agent-card-stats">{stats.suggestionCount} 个建议问题 · {stats.sessionCount} 个会话</span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}

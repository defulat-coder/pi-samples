import { useEffect, useState } from 'react';
import type { AgentDetail } from '@pi-workbench/contracts';
import { motion } from 'motion/react';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { fetchAgent } from '../lib/api.js';

const motionEase = [0.23, 1, 0.32, 1] as const;

function ConfigBody({ agent, onUseSuggestion }: { agent: AgentDetail; onUseSuggestion: (text: string) => void }) {
  return (
    <div className="config-panel-body">
      <section className="config-section">
        <h3 className="config-section-label">基本信息</h3>
        <div className="config-card">
          <div className="config-identity">
            <span className="agent-chip medium" aria-hidden="true">{agent.mark.slice(0, 2)}</span>
            <span>
              <strong>{agent.name}</strong>
              <small>{agent.tagline}</small>
            </span>
          </div>
        </div>
        {agent.description && (
          <div className="config-card">
            <p>{agent.description}</p>
          </div>
        )}
      </section>

      {agent.suggestions.length > 0 && (
        <section className="config-section">
          <h3 className="config-section-label">建议问题</h3>
          <div className="config-card">
            {agent.suggestions.map((suggestion) => (
              <button type="button" key={suggestion} className="config-suggestion" onClick={() => onUseSuggestion(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="config-section">
        <h3 className="config-section-label">系统提示词</h3>
        <div className="config-card">
          {agent.body.trim()
            ? <pre className="config-prompt-body">{agent.body.trim()}</pre>
            : <p>暂无系统提示词。</p>}
        </div>
      </section>

      <section className="config-section">
        <h3 className="config-section-label">定义文件</h3>
        <div className="config-card">
          <span className="config-path">{agent.path}</span>
        </div>
      </section>
    </div>
  );
}

/** 右侧 479px 只读配置面板（aside，内嵌非遮罩）。 */
export function ConfigPanel({ agentId, onClose, onUseSuggestion }: {
  agentId: string;
  onClose: () => void;
  onUseSuggestion: (text: string) => void;
}) {
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stale = false;
    setDetail(null);
    setError('');
    fetchAgent(agentId)
      .then((agent) => { if (!stale) setDetail(agent); })
      .catch((cause: Error) => { if (!stale) setError(cause.message); });
    return () => { stale = true; };
  }, [agentId]);

  return (
    <motion.aside
      role="complementary"
      aria-label="Agent 配置"
      className="config-panel"
      initial={{ x: 479 }}
      animate={{ x: 0 }}
      exit={{ x: 479 }}
      transition={{ duration: 0.25, ease: motionEase }}
    >
      <div className="config-panel-header">
        <span className="config-title">{detail ? detail.name : 'Agent 配置'}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭配置面板">
          <X size={16} />
        </button>
      </div>
      {error && <p className="config-panel-error" role="alert">{error}</p>}
      {!error && !detail && <p className="config-panel-loading">正在读取配置…</p>}
      {!error && detail && <ConfigBody agent={detail} onUseSuggestion={onUseSuggestion} />}
    </motion.aside>
  );
}

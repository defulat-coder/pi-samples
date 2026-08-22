import { useEffect, useState, type ReactNode } from 'react';
import type { AgentDetail, AgentResources, WorkspaceResponse } from '@pi-workbench/contracts';
import { AGENT_THINKING_LEVELS } from '@pi-workbench/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { FolderOpen } from '@phosphor-icons/react/dist/icons/FolderOpen';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { fetchAgent, fetchAgentResources, savePreference } from '../lib/api.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import {
  DEFAULT_OPEN_SECTIONS,
  readThinkingPreference,
  serverKeyForThinking,
  THINKING_PREFERENCE_OPTIONS,
  toggleSection,
  writeThinkingPreference,
  type ConfigSectionId,
  type ThinkingPreference,
} from '../lib/configPanel.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useWorkspace } from '../context/WorkspaceContext.js';
import { AgentChip } from './AgentChip.js';

/** Fleet configure 面板的通栏折叠节：48px 头 + 高度动画内容区。 */
function ConfigSection({ icon, title, open, onToggle, children }: {
  icon: ReactNode;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section className="config-section">
      <button type="button" className="config-section-header" onClick={onToggle} aria-expanded={open}>
        {icon}
        <span className="config-section-title">{title}</span>
        <CaretDown size={16} className={cx('config-section-chevron', open && 'open')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="config-section-content"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: MOTION_EASE }}
          >
            <div className="config-section-inner">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

function BasicSection({ agent, onUseSuggestion }: { agent: AgentDetail; onUseSuggestion: (text: string) => void }) {
  return (
    <>
      <div className="config-card">
        <div className="config-identity">
          <AgentChip mark={agent.mark} className="medium" />
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
      {agent.suggestions.length > 0 && (
        <div className="config-card">
          <p className="config-card-title">建议问题</p>
          {agent.suggestions.map((suggestion) => (
            <button type="button" key={suggestion} className="config-suggestion" onClick={() => onUseSuggestion(suggestion)}>
              {suggestion}
            </button>
          ))}
        </div>
      )}
      <div className="config-card">
        <p className="config-card-title">系统提示词</p>
        {agent.body.trim()
          ? <pre className="config-prompt-body">{agent.body.trim()}</pre>
          : <p>暂无系统提示词。</p>}
      </div>
      <div className="config-card">
        <p className="config-card-title">定义文件</p>
        <span className="config-path">{agent.path}</span>
      </div>
    </>
  );
}

function ResourcesSection({ resources }: { resources: AgentResources | null }) {
  if (!resources) return <p className="config-section-note">正在读取资源清单…</p>;
  return (
    <>
      <div className="config-card">
        <p className="config-card-title">提示词模板 · {resources.prompts.length}</p>
        {resources.prompts.length === 0 && <p>暂无提示词模板。</p>}
        {resources.prompts.map((prompt) => (
          <div className="config-resource-row" key={prompt.path}>
            <span className="config-path">{prompt.path}</span>
            {prompt.description && <small>{prompt.description}</small>}
          </div>
        ))}
      </div>
      <div className="config-card">
        <p className="config-card-title">技能 · {resources.skills.length}</p>
        {resources.skills.length === 0 && <p>暂无项目技能。</p>}
        {resources.skills.map((skill) => (
          <div className="config-resource-row" key={skill.path}>
            <span className="config-resource-name">{skill.name}</span>
            {skill.description && <small>{skill.description}</small>}
          </div>
        ))}
      </div>
      <div className="config-card">
        <p className="config-card-title">追加系统提示</p>
        <p>{resources.appendSystem ? '已启用：.pi/APPEND_SYSTEM.md 会追加到每个 Agent 的上下文。' : '未配置 .pi/APPEND_SYSTEM.md。'}</p>
      </div>
      <p className="config-section-note">以上均为项目本地资源，该 Agent 无外部连接。</p>
    </>
  );
}

function RuntimeSection({ models, resources, thinking, onThinkingChange }: {
  models: WorkspaceResponse['models'];
  resources: AgentResources | null;
  thinking: ThinkingPreference;
  onThinkingChange: (level: ThinkingPreference) => void;
}) {
  return (
    <>
      <div className="config-card">
        <p className="config-card-title">模型</p>
        <div className="config-kv"><span>当前模型</span><strong>{[models.current.provider, models.current.model].filter(Boolean).join(' / ') || '未配置'}</strong></div>
        <div className="config-kv"><span>可用模型</span><strong>{models.available.length} 个</strong></div>
        <div className="config-kv"><span>Thinking 级别</span><strong>默认 off · 可选 {AGENT_THINKING_LEVELS.join(' / ')}</strong></div>
      </div>
      <div className="config-card">
        <div className="config-kv"><span>会话数</span><strong>{resources ? resources.stats.sessionCount : '…'}</strong></div>
        <div className="config-kv"><span>累计提问</span><strong>{resources ? resources.stats.questionCount : '…'}</strong></div>
      </div>
      <div className="config-card">
        <p className="config-card-title">新会话默认 Thinking</p>
        <p className="config-card-desc">作为该 Agent 发起新提问时的默认 thinking 参数，仅保存在本机。</p>
        <div className="capsule-switch" role="group" aria-label="新会话默认 Thinking">
          {THINKING_PREFERENCE_OPTIONS.map((level) => (
            <button
              type="button"
              key={level}
              className={cx('capsule-option', thinking === level && 'active')}
              aria-pressed={thinking === level}
              onClick={() => onThinkingChange(level)}
            >
              {level === 'off' ? 'Off' : 'Minimal'}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** 右侧 479px 配置面板（aside，内嵌非遮罩），分节折叠对齐 Fleet configure 结构。 */
export function ConfigPanel({ agentId, onClose, onUseSuggestion }: {
  agentId: string;
  onClose: () => void;
  onUseSuggestion: (text: string) => void;
}) {
  const { workspace } = useWorkspace();
  const models = workspace.models;
  const detail = useAsyncData(() => fetchAgent(agentId), { onError: (cause) => setError(cause.message) });
  const resources = useAsyncData(() => fetchAgentResources(agentId));
  const [error, setError] = useState('');
  const [openSections, setOpenSections] = useState<ConfigSectionId[]>([...DEFAULT_OPEN_SECTIONS]);
  const [thinking, setThinking] = useState<ThinkingPreference>(() => readThinkingPreference(agentId));

  const { reload: reloadDetail, setData: setDetailData } = detail;
  const { reload: reloadResources, setData: setResourcesData } = resources;

  useEffect(() => {
    setError('');
    setOpenSections([...DEFAULT_OPEN_SECTIONS]);
    setThinking(readThinkingPreference(agentId));
    setDetailData(null);
    setResourcesData(null);
    void reloadDetail();
    void reloadResources();
    // reload/setData 身份稳定，只需跟随 agentId 重拉。
  }, [agentId, reloadDetail, setDetailData, reloadResources, setResourcesData]);

  const changeThinking = (level: ThinkingPreference) => {
    setThinking(level);
    writeThinkingPreference(agentId, level);
    void savePreference(serverKeyForThinking(agentId), level).catch(() => {
      // 服务端写穿失败时 localStorage 仍是权威缓存。
    });
  };

  return (
    <motion.aside
      role="complementary"
      aria-label="Agent 配置"
      className="config-panel"
      initial={{ x: '100%' }}
      animate={{ x: 0 }}
      exit={{ x: '100%' }}
      transition={{ duration: 0.25, ease: MOTION_EASE }}
    >
      <div className="config-panel-header">
        <span className="config-title">{detail.data ? detail.data.name : 'Agent 配置'}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭配置面板">
          <X size={16} />
        </button>
      </div>
      {error && <p className="config-panel-error" role="alert">{error}</p>}
      {!error && !detail.data && <p className="config-panel-loading">正在读取配置…</p>}
      {!error && detail.data && (
        <div className="config-panel-body">
          <ConfigSection
            icon={<Info size={16} />}
            title="基本信息"
            open={openSections.includes('basic')}
            onToggle={() => setOpenSections((prev) => toggleSection(prev, 'basic'))}
          >
            <BasicSection agent={detail.data} onUseSuggestion={onUseSuggestion} />
          </ConfigSection>
          <ConfigSection
            icon={<FolderOpen size={16} />}
            title="资源"
            open={openSections.includes('resources')}
            onToggle={() => setOpenSections((prev) => toggleSection(prev, 'resources'))}
          >
            <ResourcesSection resources={resources.data} />
          </ConfigSection>
          <ConfigSection
            icon={<GearSix size={16} />}
            title="运行设置"
            open={openSections.includes('runtime')}
            onToggle={() => setOpenSections((prev) => toggleSection(prev, 'runtime'))}
          >
            <RuntimeSection models={models} resources={resources.data} thinking={thinking} onThinkingChange={changeThinking} />
          </ConfigSection>
        </div>
      )}
    </motion.aside>
  );
}

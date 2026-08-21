import { useState } from 'react';
import type { AgentSummary, SessionSummary } from '@pi-workbench/contracts';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { ChartLine } from '@phosphor-icons/react/dist/icons/ChartLine';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { Layout } from '@phosphor-icons/react/dist/icons/Layout';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { SidebarSimple } from '@phosphor-icons/react/dist/icons/SidebarSimple';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { Tray } from '@phosphor-icons/react/dist/icons/Tray';
import { Users } from '@phosphor-icons/react/dist/icons/Users';
import { Warning } from '@phosphor-icons/react/dist/icons/Warning';
import { filterAttention, groupSessions, matchesQuery } from '../lib/sessions.js';
import type { ExploreView } from '../lib/explore.js';
import type { SystemView } from '../lib/types.js';

export type SessionFilter = 'all' | 'attention';

export type SidebarProps = {
  agents: AgentSummary[];
  currentAgentId: string | undefined;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  collapsed: boolean;
  sessionFilter: SessionFilter;
  inboxOpen: boolean;
  inboxCount: number;
  exploreView: ExploreView | null;
  systemView: SystemView | null;
  /** 账户区第二行的真实信息，如 "pi-samples · .pi/sessions"。 */
  workspaceInfo?: string;
  onToggleCollapsed: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenConfig: (agentId: string) => void;
  onSessionFilterChange: (filter: SessionFilter) => void;
  onOpenInbox: () => void;
  onCloseInbox: () => void;
  onOpenExplore: (view: ExploreView) => void;
  onOpenSystem: (view: SystemView) => void;
};

function SessionRow({ session, active, onSelect, onRename, onDelete }: {
  session: SessionSummary;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  if (editing) {
    const commit = () => {
      const title = draft.trim();
      setEditing(false);
      if (title && title !== session.title) onRename(title);
      else setDraft(session.title);
    };
    return (
      <div className={active ? 'session-row active' : 'session-row'}>
        <input
          className="session-rename-input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commit();
            if (event.key === 'Escape') { setDraft(session.title); setEditing(false); }
          }}
          aria-label="重命名会话"
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      className={active ? 'session-row active' : 'session-row'}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === 'Enter') onSelect(); }}
      title={session.title}
    >
      <span className="session-title">{session.title}</span>
      <span className="session-count">{session.questionCount} 问</span>
      <span className="session-row-actions">
        <button
          type="button"
          className="mini-button"
          aria-label="重命名会话"
          onClick={(event) => { event.stopPropagation(); setDraft(session.title); setEditing(true); }}
        >
          <PencilSimple size={12} />
        </button>
        <button
          type="button"
          className="mini-button"
          aria-label="删除会话"
          onClick={(event) => { event.stopPropagation(); onDelete(); }}
        >
          <Trash size={12} />
        </button>
      </span>
    </div>
  );
}

export function Sidebar(props: SidebarProps) {
  const { agents, currentAgentId, sessions, currentSessionId, collapsed, sessionFilter, inboxOpen, inboxCount, exploreView, systemView, workspaceInfo } = props;
  const [query, setQuery] = useState('');

  const visibleAgents = agents.filter((agent) => matchesQuery(query, agent.name, agent.tagline));
  const filteredSessions = sessionFilter === 'attention' ? filterAttention(sessions) : sessions;
  const visibleSessions = filteredSessions.filter((session) => matchesQuery(query, session.title));
  const groups = groupSessions(visibleSessions, new Date());
  const attentionCount = filterAttention(sessions).length;
  const chatActive = !inboxOpen && !exploreView && !systemView;

  return (
    <nav className={collapsed ? 'sidebar collapsed' : 'sidebar'} aria-label="侧边栏">
      <div className="sidebar-brand-row">
        <span className="sidebar-fold sidebar-brand">Pi 工作台</span>
        <button
          type="button"
          className="icon-button"
          onClick={props.onToggleCollapsed}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          <SidebarSimple size={16} />
        </button>
      </div>

      <div className="sidebar-fold">
        <label className="sidebar-search">
          <MagnifyingGlass size={12} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索…"
            aria-label="搜索 Agent 与会话"
          />
          <kbd>⌘K</kbd>
        </label>
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-fold">
          <button
            type="button"
            className={chatActive ? 'nav-row active' : 'nav-row'}
            aria-current={chatActive ? 'page' : undefined}
            onClick={props.onCloseInbox}
          >
            <ChatCircle size={12} weight="bold" />
            <span>会话</span>
          </button>
          <button
            type="button"
            className={inboxOpen ? 'nav-row active' : 'nav-row'}
            aria-current={inboxOpen ? 'page' : undefined}
            onClick={props.onOpenInbox}
          >
            <Tray size={12} weight="bold" />
            <span>收件箱</span>
            {inboxCount > 0 && <span className="nav-badge" aria-label={`${inboxCount} 个会话需要处理`}>{inboxCount}</span>}
          </button>

          <div className="group-header">
            <span className="group-header-label">我的 Agent</span>
            <button type="button" className="group-add-button" onClick={props.onNewSession} aria-label="新建会话" title="新建会话">
              <Plus size={12} weight="bold" />
            </button>
          </div>

          {visibleAgents.map((agent) => (
            <div
              role="button"
              tabIndex={0}
              key={agent.id}
              className={agent.id === currentAgentId ? 'agent-row active' : 'agent-row'}
              onClick={() => props.onSelectAgent(agent.id)}
              onKeyDown={(event) => { if (event.key === 'Enter') props.onSelectAgent(agent.id); }}
            >
              <span className="agent-chip" aria-hidden="true">{agent.mark.slice(0, 2)}</span>
              <span className="agent-name">{agent.name}</span>
              <span className="agent-row-actions">
                <button
                  type="button"
                  className="mini-button"
                  aria-label={`查看 ${agent.name} 配置`}
                  onClick={(event) => { event.stopPropagation(); props.onOpenConfig(agent.id); }}
                >
                  <Info size={12} />
                </button>
              </span>
            </div>
          ))}
          {!visibleAgents.length && <p className="sidebar-empty-hint">没有匹配的 Agent</p>}

          {currentAgentId && chatActive && (
            <div className="session-tabs" role="tablist" aria-label="会话过滤">
              <button
                type="button"
                role="tab"
                aria-selected={sessionFilter === 'all'}
                className={sessionFilter === 'all' ? 'session-tab active' : 'session-tab'}
                onClick={() => props.onSessionFilterChange('all')}
              >
                全部
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sessionFilter === 'attention'}
                className={sessionFilter === 'attention' ? 'session-tab active' : 'session-tab'}
                onClick={() => props.onSessionFilterChange('attention')}
              >
                <Warning size={12} aria-hidden="true" />
                需处理
                <span className="session-tab-count">({attentionCount})</span>
              </button>
            </div>
          )}

          {groups.map((group) => (
            <div key={group.key}>
              <p className="session-group-label">{group.label}</p>
              {group.items.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === currentSessionId}
                  onSelect={() => props.onSelectSession(session.id)}
                  onRename={(title) => props.onRenameSession(session.id, title)}
                  onDelete={() => props.onDeleteSession(session.id)}
                />
              ))}
            </div>
          ))}
          {currentAgentId && !visibleSessions.length && (
            <p className="sidebar-empty-hint">
              {sessionFilter === 'attention' ? '没有需要处理的会话' : '暂无会话，点击右上角 + 开始'}
            </p>
          )}

          <div className="group-header">
            <span className="group-header-label">探索</span>
          </div>
          <button
            type="button"
            className={exploreView === 'agents' ? 'nav-row active' : 'nav-row'}
            aria-current={exploreView === 'agents' ? 'page' : undefined}
            onClick={() => props.onOpenExplore('agents')}
          >
            <Users size={12} weight="bold" />
            <span>Agents</span>
          </button>
          <button
            type="button"
            className={exploreView === 'templates' ? 'nav-row active' : 'nav-row'}
            aria-current={exploreView === 'templates' ? 'page' : undefined}
            onClick={() => props.onOpenExplore('templates')}
          >
            <Layout size={12} weight="bold" />
            <span>模板</span>
          </button>
          <button
            type="button"
            className={exploreView === 'skills' ? 'nav-row active' : 'nav-row'}
            aria-current={exploreView === 'skills' ? 'page' : undefined}
            onClick={() => props.onOpenExplore('skills')}
          >
            <PuzzlePiece size={12} weight="bold" />
            <span>技能</span>
          </button>
        </div>
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={systemView === 'usage' ? 'nav-row active' : 'nav-row'}
          aria-current={systemView === 'usage' ? 'page' : undefined}
          onClick={() => props.onOpenSystem('usage')}
          title="用量"
        >
          <ChartLine size={12} weight="bold" />
          <span className="sidebar-fold">用量</span>
        </button>
        <button
          type="button"
          className={systemView === 'settings' ? 'nav-row active' : 'nav-row'}
          aria-current={systemView === 'settings' ? 'page' : undefined}
          onClick={() => props.onOpenSystem('settings')}
          title="设置"
        >
          <GearSix size={12} weight="bold" />
          <span className="sidebar-fold">设置</span>
        </button>
        <div className="account-row" title={`本地模式 · 无需登录${workspaceInfo ? ` · ${workspaceInfo}` : ''}`}>
          <span className="account-mark" aria-hidden="true">π</span>
          <span className="account-copy">
            <strong>本地模式</strong>
            <small>{workspaceInfo ?? '数据保存在本项目内'}</small>
          </span>
        </div>
      </div>
    </nav>
  );
}

import { useState } from 'react';
import type { AgentSummary, SessionSummary } from '@pi-workbench/contracts';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { SidebarSimple } from '@phosphor-icons/react/dist/icons/SidebarSimple';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { groupSessions, matchesQuery } from '../lib/sessions.js';

export type SidebarProps = {
  agents: AgentSummary[];
  currentAgentId: string | undefined;
  sessions: SessionSummary[];
  currentSessionId: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectSession: (sessionId: string) => void;
  onNewSession: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenConfig: (agentId: string) => void;
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
  const { agents, currentAgentId, sessions, currentSessionId, collapsed } = props;
  const [query, setQuery] = useState('');

  const visibleAgents = agents.filter((agent) => matchesQuery(query, agent.name, agent.tagline));
  const visibleSessions = sessions.filter((session) => matchesQuery(query, session.title));
  const groups = groupSessions(visibleSessions, new Date());

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
          <button type="button" className="nav-row active" aria-current="page">
            <ChatCircle size={12} weight="bold" />
            <span>会话</span>
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
          {currentAgentId && !visibleSessions.length && <p className="sidebar-empty-hint">暂无会话，点击右上角 + 开始</p>}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="account-row" title="本地模式 · 无需登录">
          <span className="account-mark" aria-hidden="true">π</span>
          <span className="account-copy">
            <strong>本地模式</strong>
            <small>数据保存在本项目内</small>
          </span>
        </div>
      </div>
    </nav>
  );
}

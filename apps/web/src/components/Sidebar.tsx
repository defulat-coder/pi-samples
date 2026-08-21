import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AgentSummary } from '@pi-workbench/contracts';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { ChartLine } from '@phosphor-icons/react/dist/icons/ChartLine';
import { GearSix } from '@phosphor-icons/react/dist/icons/GearSix';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { Keyboard } from '@phosphor-icons/react/dist/icons/Keyboard';
import { Layout } from '@phosphor-icons/react/dist/icons/Layout';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { SidebarSimple } from '@phosphor-icons/react/dist/icons/SidebarSimple';
import { Tray } from '@phosphor-icons/react/dist/icons/Tray';
import { Users } from '@phosphor-icons/react/dist/icons/Users';
import type { ExploreView } from '../lib/explore.js';
import type { SystemView } from '../lib/types.js';

export type SidebarProps = {
  agents: AgentSummary[];
  currentAgentId: string | undefined;
  collapsed: boolean;
  inboxOpen: boolean;
  inboxCount: number;
  /** 每个 Agent 需要处理的会话数（用于行尾徽标）。 */
  attentionByAgent: Record<string, number>;
  exploreView: ExploreView | null;
  systemView: SystemView | null;
  /** 账户区第二行的真实信息，如 "pi-samples · .pi/sessions"。 */
  workspaceInfo?: string;
  onToggleCollapsed: () => void;
  onSelectAgent: (agentId: string) => void;
  onOpenConfig: (agentId: string) => void;
  /** Fleet 的 "New agent"：打开模板页创建 Agent。 */
  onNewAgent: () => void;
  /** Fleet 的 Search（⌘K）：打开命令面板。 */
  onOpenPalette: () => void;
  /** Fleet 的 Keyboard Shortcuts 导航项。 */
  onOpenShortcuts: () => void;
  onOpenInbox: () => void;
  onCloseInbox: () => void;
  onOpenExplore: (view: ExploreView) => void;
  onOpenSystem: (view: SystemView) => void;
};

function NavIcon({ children }: { children: ReactNode }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

/** Fleet 侧边栏：纯导航（工作区 / 搜索 / Chat / Inbox / Explore / My Agents / Usage / Settings / 账户）。 */
export function Sidebar(props: SidebarProps) {
  const { agents, currentAgentId, collapsed, inboxOpen, inboxCount, attentionByAgent, exploreView, systemView, workspaceInfo } = props;
  const [exploreOpen, setExploreOpen] = useState(true);
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);

  const chatActive = !inboxOpen && !exploreView && !systemView;

  // ⌘B 收起/展开侧边栏；⌘K 打开命令面板（Fleet 同名快捷键）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'b') {
        event.preventDefault();
        props.onToggleCollapsed();
      } else if (event.key === 'k') {
        event.preventDefault();
        props.onOpenPalette();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [props.onToggleCollapsed, props.onOpenPalette]);

  // 工作区信息弹层：点外部或 Escape 关闭
  useEffect(() => {
    if (!workspaceOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!workspaceRef.current?.contains(event.target as Node)) setWorkspaceOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWorkspaceOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [workspaceOpen]);

  return (
    <nav className={collapsed ? 'sidebar collapsed' : 'sidebar'} aria-label="侧边栏">
      <div className="sidebar-brand-row">
        <div className="sidebar-fold workspace-wrap" ref={workspaceRef}>
          <button
            type="button"
            className="workspace-button"
            onClick={() => setWorkspaceOpen((open) => !open)}
            aria-expanded={workspaceOpen}
            aria-label="工作区"
          >
            <span className="workspace-mark" aria-hidden="true">π</span>
            <span className="workspace-name">Pi 工作台</span>
            <CaretDown size={12} className="workspace-chevron" />
          </button>
          {workspaceOpen && (
            <div className="workspace-popover" role="dialog" aria-label="工作区信息">
              <p className="workspace-popover-title">本地工作区</p>
              <p className="workspace-popover-line">本地模式 · 无需登录</p>
              {workspaceInfo && <p className="workspace-popover-line">{workspaceInfo}</p>}
            </div>
          )}
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={props.onToggleCollapsed}
          aria-label={collapsed ? '展开侧边栏 (⌘B)' : '收起侧边栏 (⌘B)'}
        >
          <SidebarSimple size={16} />
        </button>
      </div>

      <div className="sidebar-fold">
        <button type="button" className="sidebar-search" onClick={props.onOpenPalette} aria-label="搜索 (⌘K)">
          <MagnifyingGlass size={12} />
          <span className="sidebar-search-placeholder">搜索…</span>
          <span className="search-kbd-group" aria-hidden="true">
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </span>
        </button>
      </div>

      <div className="sidebar-scroll">
        <button
          type="button"
          className={chatActive ? 'nav-row active' : 'nav-row'}
          aria-current={chatActive ? 'page' : undefined}
          onClick={props.onCloseInbox}
          title="会话"
        >
          <NavIcon><ChatCircle size={12} weight="bold" /></NavIcon>
          <span className="sidebar-fold">会话</span>
        </button>
        <button
          type="button"
          className={inboxOpen ? 'nav-row active' : 'nav-row'}
          aria-current={inboxOpen ? 'page' : undefined}
          onClick={props.onOpenInbox}
          title="收件箱"
        >
          <NavIcon><Tray size={12} weight="bold" /></NavIcon>
          <span className="sidebar-fold">收件箱</span>
          {inboxCount > 0 && <span className="nav-badge" aria-label={`${inboxCount} 个会话需要处理`}>{inboxCount}</span>}
        </button>
        <button
          type="button"
          className="nav-row"
          onClick={props.onOpenShortcuts}
          title="键盘快捷键"
        >
          <NavIcon><Keyboard size={12} weight="bold" /></NavIcon>
          <span className="sidebar-fold">快捷键</span>
        </button>

        <div className="sidebar-divider" role="separator" />

        <div className="group-header">
          <button type="button" className="group-header-toggle" onClick={() => setExploreOpen((open) => !open)} aria-expanded={exploreOpen}>
            <CaretDown size={12} className={exploreOpen ? 'group-header-chevron' : 'group-header-chevron closed'} />
            <span className="group-header-label">探索</span>
          </button>
        </div>
        {exploreOpen && (
          <>
            <button
              type="button"
              className={exploreView === 'agents' ? 'nav-row active' : 'nav-row'}
              aria-current={exploreView === 'agents' ? 'page' : undefined}
              onClick={() => props.onOpenExplore('agents')}
              title="Agents"
            >
              <NavIcon><Users size={12} weight="bold" /></NavIcon>
              <span className="sidebar-fold">Agents</span>
            </button>
            <button
              type="button"
              className={exploreView === 'templates' ? 'nav-row active' : 'nav-row'}
              aria-current={exploreView === 'templates' ? 'page' : undefined}
              onClick={() => props.onOpenExplore('templates')}
              title="模板"
            >
              <NavIcon><Layout size={12} weight="bold" /></NavIcon>
              <span className="sidebar-fold">模板</span>
            </button>
            <button
              type="button"
              className={exploreView === 'skills' ? 'nav-row active' : 'nav-row'}
              aria-current={exploreView === 'skills' ? 'page' : undefined}
              onClick={() => props.onOpenExplore('skills')}
              title="技能"
            >
              <NavIcon><PuzzlePiece size={12} weight="bold" /></NavIcon>
              <span className="sidebar-fold">技能</span>
            </button>
          </>
        )}

        <div className="sidebar-divider" role="separator" />

        <div className="group-header">
          <button type="button" className="group-header-toggle" onClick={() => setAgentsOpen((open) => !open)} aria-expanded={agentsOpen}>
            <CaretDown size={12} className={agentsOpen ? 'group-header-chevron' : 'group-header-chevron closed'} />
            <span className="group-header-label">我的 Agent</span>
          </button>
          <button type="button" className="group-add-button" onClick={props.onNewAgent} aria-label="新建 Agent" title="从模板新建 Agent">
            <Plus size={12} weight="bold" />
          </button>
        </div>
        {agentsOpen && (
          <>
            {agents.map((agent) => (
              <div
                role="button"
                tabIndex={0}
                key={agent.id}
                className={agent.id === currentAgentId ? 'agent-row active' : 'agent-row'}
                title={agent.name}
                onClick={() => props.onSelectAgent(agent.id)}
                onKeyDown={(event) => { if (event.key === 'Enter') props.onSelectAgent(agent.id); }}
              >
                <span className="agent-chip" aria-hidden="true">{agent.mark.slice(0, 2)}</span>
                <span className="agent-name">{agent.name}</span>
                {(attentionByAgent[agent.id] ?? 0) > 0 && (
                  <span className="nav-badge agent-badge" aria-label={`${attentionByAgent[agent.id]} 个会话需要处理`}>{attentionByAgent[agent.id]}</span>
                )}
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
            {!agents.length && <p className="sidebar-empty-hint">暂无 Agent，点右上角 + 从模板创建</p>}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className={systemView === 'usage' ? 'nav-row active' : 'nav-row'}
          aria-current={systemView === 'usage' ? 'page' : undefined}
          onClick={() => props.onOpenSystem('usage')}
          title="用量"
        >
          <NavIcon><ChartLine size={12} weight="bold" /></NavIcon>
          <span className="sidebar-fold">用量</span>
        </button>
        <button
          type="button"
          className={systemView === 'settings' ? 'nav-row active' : 'nav-row'}
          aria-current={systemView === 'settings' ? 'page' : undefined}
          onClick={() => props.onOpenSystem('settings')}
          title="设置"
        >
          <NavIcon><GearSix size={12} weight="bold" /></NavIcon>
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

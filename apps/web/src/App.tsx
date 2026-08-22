import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary, SessionSummary, WorkspaceResponse } from '@pi-workbench/contracts';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { SlidersHorizontal } from '@phosphor-icons/react/dist/icons/SlidersHorizontal';
import { deleteSession, fetchInbox, fetchPreferences, fetchSessions, fetchSettings, fetchUsage, fetchWorkspace, renameSession, savePreference } from './lib/api.js';
import { cx } from './lib/cx.js';
import { sortSessions } from './lib/sessions.js';
import type { ExploreView } from './lib/explore.js';
import type { SystemView, ViewState } from './lib/types.js';
import { mergeServerThinkingPreferences } from './lib/configPanel.js';
import { MOTION_EASE } from './lib/motion.js';
import { mergeServerUiPreferences, readUiPreferences, serverKeyForPreference, writeUiPreference, type UiPreferences } from './lib/preferences.js';
import { useAsyncData } from './hooks/useAsyncData.js';
import { useChatController } from './hooks/useChatController.js';
import { WorkspaceProvider } from './context/WorkspaceContext.js';
import { Sidebar } from './components/Sidebar.js';
import { Toasts, type Toast } from './components/Toasts.js';
import { InboxColumn, type SessionFilter } from './components/InboxColumn.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ShortcutsModal } from './components/ShortcutsModal.js';
import type { PaletteAction } from './lib/palette.js';
import { UsageBar } from './components/UsageBar.js';
import { Welcome } from './components/Welcome.js';
import { Composer } from './components/Composer.js';
import { ThreadView } from './components/ThreadView.js';
import { ConfigPanel } from './components/ConfigPanel.js';
import { InboxView } from './components/InboxView.js';
import { ExploreAgents } from './components/ExploreAgents.js';
import { TemplatesView } from './components/TemplatesView.js';
import { SkillsView } from './components/SkillsView.js';
import { UsageView } from './components/UsageView.js';
import { SettingsView } from './components/SettingsView.js';

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [fatal, setFatal] = useState('');
  const [currentAgentId, setCurrentAgentId] = useState<string | undefined>(undefined);
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, SessionSummary[]>>({});
  const [selectedModel, setSelectedModel] = useState<string | undefined>(undefined);
  const [uiPreferences, setUiPreferences] = useState<UiPreferences>(() => readUiPreferences());
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readUiPreferences().sidebarCollapsed);
  const [inboxColumnCollapsed, setInboxColumnCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const [sessionFilter, setSessionFilter] = useState<SessionFilter>('all');
  /** 主区域互斥视图：chat / inbox / explore / system 由 union 类型保证同一时刻只有一个。 */
  const [view, setView] = useState<ViewState>({ kind: 'chat' });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  /** 用户可见的错误通知；4 秒自动消失。 */
  const notify = useCallback((text: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev, { id, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((toast) => toast.id !== id)), 4000);
  }, []);

  // 派生布尔值保持既有判断语义；写入一律走 setView。
  const inboxOpen = view.kind === 'inbox';
  const exploreView = view.kind === 'explore' ? view.view : null;
  const systemView = view.kind === 'system' ? view.view : null;

  const currentAgent: AgentSummary | undefined = workspace?.agents.find((agent) => agent.id === currentAgentId);
  const sessions = useMemo(
    () => (currentAgentId ? sortSessions(sessionsByAgent[currentAgentId] ?? []) : []),
    [sessionsByAgent, currentAgentId],
  );

  const inbox = useAsyncData(fetchInbox, { onError: () => notify('收件箱暂时无法读取') });
  const usage = useAsyncData(fetchUsage);
  const settings = useAsyncData(fetchSettings);

  /** 每个 Agent 的待处理会话数，来自收件箱数据。 */
  const attentionByAgent = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of inbox.data ?? []) map[item.agentId] = (map[item.agentId] ?? 0) + 1;
    return map;
  }, [inbox.data]);

  const loadSessions = useCallback(async (agentId: string) => {
    try {
      const items = await fetchSessions(agentId);
      setSessionsByAgent((prev) => ({ ...prev, [agentId]: items }));
    } catch {
      notify('会话列表暂时无法读取');
    }
  }, [notify]);

  const chat = useChatController({
    notify,
    onTurnSettled: (agentId) => {
      void loadSessions(agentId);
      void inbox.reload();
    },
  });

  const handlePreferenceChange = (key: keyof UiPreferences, value: boolean) => {
    setUiPreferences((current) => writeUiPreference(current, key, value));
    void savePreference(serverKeyForPreference(key), value).catch(() => {
      // 服务端写穿失败时 localStorage 仍是权威缓存，但让用户知道没有持久化。
      notify('偏好已在本机生效，但未能同步到服务端');
    });
  };

  /** 服务端偏好（SQLite）覆盖本地缓存；本地读不到时保持默认。 */
  const loadPreferences = useCallback(async () => {
    try {
      const items = await fetchPreferences();
      const merged = mergeServerUiPreferences(items);
      setUiPreferences(merged);
      setSidebarCollapsed(merged.sidebarCollapsed);
      mergeServerThinkingPreferences(items);
    } catch {
      // 偏好服务不可用时沿用本地缓存。
    }
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const snapshot = await fetchWorkspace();
      setWorkspace(snapshot);
      const first = snapshot.agents[0];
      if (first) {
        setCurrentAgentId((prev) => prev ?? first.id);
        void loadSessions(first.id);
      }
      void inbox.reload();
      void settings.reload();
      void loadPreferences();
    } catch (error) {
      setFatal(error instanceof Error ? error.message : '工作区信息暂时无法读取');
    }
  }, [loadSessions, loadPreferences, inbox.reload, settings.reload]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const send = (text: string) => {
    if (currentAgentId) chat.send(text, currentAgentId, selectedModel);
  };

  const selectAgent = (agentId: string) => {
    if (agentId === currentAgentId && !exploreView && !systemView) return;
    chat.interrupt();
    setCurrentAgentId(agentId);
    chat.closeSession();
    setConfigAgentId(null);
    setView({ kind: 'chat' });
    if (!sessionsByAgent[agentId]) void loadSessions(agentId);
  };

  const selectSession = (sessionId: string) => {
    if (sessionId === chat.currentSessionId && !exploreView && !systemView) return;
    setView({ kind: 'chat' });
    if (currentAgentId) chat.openSession(currentAgentId, sessionId);
  };

  const newSession = () => {
    setView({ kind: 'chat' });
    chat.closeSession();
    setConfigAgentId(null);
  };

  const openExplore = (target: ExploreView) => {
    setConfigAgentId(null);
    setView({ kind: 'explore', view: target });
  };

  const openSystem = (target: SystemView) => {
    setConfigAgentId(null);
    setView({ kind: 'system', view: target });
    if (target === 'usage') void usage.reload();
    else void settings.reload();
  };

  const handleAgentCreated = async () => {
    try {
      setWorkspace(await fetchWorkspace());
    } catch {
      // 刷新失败时下次进入页面再拉。
    }
    setView({ kind: 'explore', view: 'agents' });
  };

  const openInboxItem = (agentId: string, sessionId: string) => {
    setView({ kind: 'chat' });
    if (agentId !== currentAgentId) {
      chat.interrupt();
      setCurrentAgentId(agentId);
      if (!sessionsByAgent[agentId]) void loadSessions(agentId);
    }
    setConfigAgentId(null);
    chat.openSession(agentId, sessionId);
  };

  const handlePaletteAction = (action: PaletteAction) => {
    switch (action.kind) {
      case 'chat':
        setView({ kind: 'chat' });
        break;
      case 'inbox':
        setView({ kind: 'inbox' });
        void inbox.reload();
        break;
      case 'explore':
        openExplore(action.view);
        break;
      case 'system':
        openSystem(action.view);
        break;
      case 'agent':
        selectAgent(action.agentId);
        break;
      case 'session':
        openInboxItem(action.agentId, action.sessionId);
        break;
    }
  };

  const handleRename = async (sessionId: string, title: string) => {
    if (!currentAgentId) return;
    try {
      await renameSession(currentAgentId, sessionId, title);
      await loadSessions(currentAgentId);
    } catch {
      notify('会话名称暂时无法保存');
    }
  };

  const handleDelete = async (sessionId: string) => {
    if (!currentAgentId) return;
    try {
      await deleteSession(currentAgentId, sessionId);
      chat.removeThread(sessionId);
      await loadSessions(currentAgentId);
      void inbox.reload();
    } catch {
      notify('会话暂时无法删除');
    }
  };

  if (fatal) {
    return (
      <div className="app-shell">
        <main className="app-fatal">
          <p>{fatal}</p>
          <button type="button" onClick={() => { setFatal(''); void bootstrap(); }}>重试</button>
        </main>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="app-shell">
        <main className="app-loading" aria-live="polite">正在加载工作区…</main>
      </div>
    );
  }

  const showWelcome = !chat.currentSessionId;
  /** 视图级 key：只有跨视图切换才重放入场动画，Agent/会话切换不重挂载主区。 */
  const viewKey = exploreView ? `explore-${exploreView}` : systemView ? `system-${systemView}` : inboxOpen ? 'inbox' : 'chat';

  return (
    <WorkspaceProvider value={{ workspace, sessionsByAgent, notify }}>
    <MotionConfig reducedMotion="user">
      <div className="app-shell">
        <Sidebar
          currentAgentId={currentAgentId}
          collapsed={sidebarCollapsed}
          inboxOpen={inboxOpen}
          inboxCount={(inbox.data ?? []).length}
          attentionByAgent={attentionByAgent}
          exploreView={exploreView}
          systemView={systemView}
          workspaceInfo={settings.data ? `${settings.data.workspace.name} · ${settings.data.workspace.sessionDir}` : undefined}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onSelectAgent={selectAgent}
          onOpenConfig={setConfigAgentId}
          onNewAgent={() => openExplore('templates')}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenInbox={() => { setView({ kind: 'inbox' }); void inbox.reload(); }}
          onCloseInbox={() => setView({ kind: 'chat' })}
          onOpenExplore={openExplore}
          onOpenSystem={openSystem}
        />

        {!exploreView && !systemView && !inboxOpen && currentAgent && (
          <InboxColumn
            title={currentAgent.name}
            sessions={sessions}
            currentSessionId={chat.currentSessionId}
            filter={sessionFilter}
            collapsed={inboxColumnCollapsed}
            onToggleCollapsed={() => setInboxColumnCollapsed((value) => !value)}
            onSelectSession={selectSession}
            onRenameSession={(id, title) => void handleRename(id, title)}
            onDeleteSession={(id) => void handleDelete(id)}
            onFilterChange={setSessionFilter}
          />
        )}

        <main className="main-area">
          {/* 视图切换入场淡入：key 到视图级，切换即时（无 exit），不随 Agent/会话变化重挂载 */}
          <motion.div
            key={viewKey}
            className="view-body"
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15, ease: MOTION_EASE }}
          >
            {!exploreView && !systemView && !inboxOpen && <UsageBar agent={currentAgent} sessions={sessions} />}

            {exploreView === 'agents' ? (
              <ExploreAgents onOpenChat={selectAgent} />
            ) : exploreView === 'templates' ? (
              <TemplatesView onCreated={() => void handleAgentCreated()} />
            ) : exploreView === 'skills' ? (
              <SkillsView />
            ) : systemView === 'usage' ? (
              <UsageView usage={usage.data} loading={usage.loading} onRefresh={() => void usage.reload()} />
            ) : systemView === 'settings' ? (
              <SettingsView settings={settings.data} loading={settings.loading} preferences={uiPreferences} onPreferenceChange={handlePreferenceChange} />
            ) : inboxOpen ? (
              <InboxView
                items={inbox.data ?? []}
                loading={inbox.loading}
                onRefresh={() => void inbox.reload()}
                onOpen={openInboxItem}
              />
            ) : (
              <>
                {!showWelcome && (
                  <div className="thread-header">
                    <button type="button" className="header-button primary" onClick={newSession}>
                      <Plus size={13} weight="bold" />
                      新会话
                    </button>
                    {currentAgentId && (
                      <button
                        type="button"
                        className={cx('header-button', configAgentId && 'active')}
                        onClick={() => setConfigAgentId((prev) => (prev ? null : currentAgentId))}
                      >
                        <SlidersHorizontal size={13} />
                        配置
                      </button>
                    )}
                  </div>
                )}

                {/* Welcome 淡出完成后再挂载会话区，避免两棵子树共存撑开布局 */}
                <AnimatePresence mode="wait" initial={false}>
                  {showWelcome && currentAgent ? (
                    <motion.div key="welcome" className="chat-branch" exit={{ opacity: 0 }} transition={{ duration: 0.15, ease: MOTION_EASE }}>
                      <Welcome agent={currentAgent} onSuggestion={send} />
                      <div className="composer-wrap welcome-composer">
                        <Composer
                          disabled={Boolean(chat.liveTurn)}
                          selectedModel={selectedModel}
                          onSelectModel={setSelectedModel}
                          onSend={send}
                        />
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div key="thread" className="chat-branch">
                      <ThreadView messages={chat.threadMessages} compact={uiPreferences.compactMessages} />
                      <div className="composer-wrap">
                        <div className="composer-inner">
                          <Composer
                            disabled={Boolean(chat.liveTurn)}
                            selectedModel={selectedModel}
                            onSelectModel={setSelectedModel}
                            onSend={send}
                          />
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          </motion.div>
        </main>

        <CommandPalette
          open={paletteOpen}
          onAction={handlePaletteAction}
          onClose={() => setPaletteOpen(false)}
        />
        <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

        <AnimatePresence>
          {configAgentId && (
            <ConfigPanel
              agentId={configAgentId}
              onClose={() => setConfigAgentId(null)}
              onUseSuggestion={(text) => { setConfigAgentId(null); send(text); }}
            />
          )}
        </AnimatePresence>

        <Toasts toasts={toasts} />
      </div>
    </MotionConfig>
    </WorkspaceProvider>
  );
}

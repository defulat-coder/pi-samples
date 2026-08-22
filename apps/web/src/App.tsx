import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary, ChatStreamEvent, SessionSummary, SettingsResponse, UsageResponse, WorkspaceResponse } from '@pi-workbench/contracts';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { SlidersHorizontal } from '@phosphor-icons/react/dist/icons/SlidersHorizontal';
import { deleteSession, fetchInbox, fetchPreferences, fetchSessionMessages, fetchSessions, fetchSettings, fetchUsage, fetchWorkspace, renameSession, savePreference, streamChat } from './lib/api.js';
import { createLiveTurn, reduceStreamEvent, type LiveTurn } from './lib/stream.js';
import { sortSessions } from './lib/sessions.js';
import type { ExploreView } from './lib/explore.js';
import { newMessageId, type ChatMessage, type SystemView, type ViewState } from './lib/types.js';
import { readThinkingPreference, mergeServerThinkingPreferences } from './lib/configPanel.js';
import { mergeServerUiPreferences, readUiPreferences, serverKeyForPreference, writeUiPreference, type UiPreferences } from './lib/preferences.js';
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

type ThreadState = {
  messages: ChatMessage[];
  /** true 表示历史消息已从服务端回放完成（或本次会话内产生，无需回放）。 */
  historyLoaded: boolean;
};

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [fatal, setFatal] = useState('');
  const [currentAgentId, setCurrentAgentId] = useState<string | undefined>(undefined);
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, SessionSummary[]>>({});
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, ThreadState>>({});
  const [liveTurn, setLiveTurn] = useState<(LiveTurn & { messageId: string }) | null>(null);
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
  const [inboxItems, setInboxItems] = useState<SessionSummary[]>([]);
  const [inboxLoading, setInboxLoading] = useState(false);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

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
  const currentThread: ThreadState | undefined = currentSessionId ? threads[currentSessionId] : undefined;
  /** 每个 Agent 的待处理会话数，来自收件箱数据。 */
  const attentionByAgent = useMemo(() => {
    const map: Record<string, number> = {};
    for (const item of inboxItems) map[item.agentId] = (map[item.agentId] ?? 0) + 1;
    return map;
  }, [inboxItems]);

  /** 回放一个已持久化会话的历史消息；加载期间新产生的内存消息优先保留。 */
  const loadThread = useCallback(async (agentId: string, sessionId: string) => {
    try {
      const items = await fetchSessionMessages(agentId, sessionId);
      const messages: ChatMessage[] = items.map((item) => ({
        id: item.id,
        role: item.role,
        text: item.content,
        ...(item.thinking ? { thinking: item.thinking } : {}),
        ...(item.usage ? { usage: item.usage } : {}),
        ...(item.stopReason === 'error' || item.stopReason === 'aborted' ? { error: item.errorMessage ?? '本轮回复失败' } : {}),
      }));
      setThreads((prev) => {
        const existing = prev[sessionId];
        if (existing && existing.messages.length) return { ...prev, [sessionId]: { ...existing, historyLoaded: true } };
        return { ...prev, [sessionId]: { messages, historyLoaded: true } };
      });
    } catch {
      // 历史读取失败：标记已处理避免反复请求，并告知用户可以重试。
      setThreads((prev) => (prev[sessionId] ? { ...prev, [sessionId]: { ...prev[sessionId]!, historyLoaded: true } } : prev));
      notify('历史消息暂时无法读取，重新打开会话可重试');
    }
  }, [notify]);

  const loadSessions = useCallback(async (agentId: string) => {
    try {
      const items = await fetchSessions(agentId);
      setSessionsByAgent((prev) => ({ ...prev, [agentId]: items }));
    } catch {
      notify('会话列表暂时无法读取');
    }
  }, [notify]);

  const loadInbox = useCallback(async () => {
    setInboxLoading(true);
    try {
      setInboxItems(await fetchInbox());
    } catch {
      notify('收件箱暂时无法读取');
    } finally {
      setInboxLoading(false);
    }
  }, [notify]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    try {
      setUsage(await fetchUsage());
    } catch {
      // 用量页失败时保留旧数据。
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      setSettings(await fetchSettings());
    } catch {
      // 设置页失败时保留旧数据。
    } finally {
      setSettingsLoading(false);
    }
  }, []);

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
      void loadInbox();
      void loadSettings();
      void loadPreferences();
    } catch (error) {
      setFatal(error instanceof Error ? error.message : '工作区信息暂时无法读取');
    }
  }, [loadSessions, loadInbox, loadSettings, loadPreferences]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const selectAgent = (agentId: string) => {
    if (agentId === currentAgentId && !exploreView && !systemView) return;
    abortRef.current?.abort();
    setLiveTurn(null);
    setCurrentAgentId(agentId);
    setCurrentSessionId(null);
    setConfigAgentId(null);
    setView({ kind: 'chat' });
    if (!sessionsByAgent[agentId]) void loadSessions(agentId);
  };

  /** 初始化一个线程占位并回放历史消息（selectSession / openInboxItem 共用）。 */
  const ensureThread = (agentId: string, sessionId: string) => {
    if (threads[sessionId]) return;
    setThreads((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: { messages: [], historyLoaded: false } }));
    void loadThread(agentId, sessionId);
  };

  const selectSession = (sessionId: string) => {
    if (sessionId === currentSessionId && !exploreView && !systemView) return;
    setView({ kind: 'chat' });
    setCurrentSessionId(sessionId);
    if (currentAgentId) ensureThread(currentAgentId, sessionId);
  };

  const newSession = () => {
    setView({ kind: 'chat' });
    setCurrentSessionId(null);
    setConfigAgentId(null);
  };

  const openExplore = (target: ExploreView) => {
    setConfigAgentId(null);
    setView({ kind: 'explore', view: target });
  };

  const openSystem = (target: SystemView) => {
    setConfigAgentId(null);
    setView({ kind: 'system', view: target });
    if (target === 'usage') void loadUsage();
    else void loadSettings();
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
      abortRef.current?.abort();
      setLiveTurn(null);
      setCurrentAgentId(agentId);
      if (!sessionsByAgent[agentId]) void loadSessions(agentId);
    }
    setConfigAgentId(null);
    setCurrentSessionId(sessionId);
    ensureThread(agentId, sessionId);
  };

  const handlePaletteAction = (action: PaletteAction) => {
    switch (action.kind) {
      case 'chat':
        setView({ kind: 'chat' });
        break;
      case 'inbox':
        setView({ kind: 'inbox' });
        void loadInbox();
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
      if (sessionId === currentSessionId) setCurrentSessionId(null);
      setThreads((prev) => {
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      await loadSessions(currentAgentId);
      void loadInbox();
    } catch {
      notify('会话暂时无法删除');
    }
  };

  const send = (text: string) => {
    const agentId = currentAgentId;
    if (!agentId || liveTurn) return;

    const userMessage: ChatMessage = { id: newMessageId(), role: 'user', text };
    const assistantMessage: ChatMessage = { id: newMessageId(), role: 'assistant', text: '', streaming: true };
    const sessionKey = currentSessionId;

    const appendToThread = (key: string, items: ChatMessage[]) => {
      setThreads((prev) => {
        const thread = prev[key] ?? { messages: [], historyLoaded: true };
        return { ...prev, [key]: { ...thread, messages: [...thread.messages, ...items], historyLoaded: true } };
      });
    };

    if (sessionKey) appendToThread(sessionKey, [userMessage, assistantMessage]);

    const controller = new AbortController();
    abortRef.current = controller;
    let turn = createLiveTurn();
    let resolvedSessionId = sessionKey;
    setLiveTurn({ ...turn, messageId: assistantMessage.id });

    const onEvent = (event: ChatStreamEvent) => {
      turn = reduceStreamEvent(turn, event);
      if (event.type === 'start' && !resolvedSessionId) {
        resolvedSessionId = event.sessionId;
        setCurrentSessionId(event.sessionId);
        appendToThread(event.sessionId, [userMessage, assistantMessage]);
      }
      setLiveTurn({ ...turn, messageId: assistantMessage.id });
    };

    streamChat(
      { agentId, message: text, thinking: readThinkingPreference(agentId), ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}), ...(selectedModel ? { model: selectedModel } : {}) },
      onEvent,
      controller.signal,
    )
      .then((done) => {
        finalize(turn.answer || done.answer, undefined);
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) {
          finalize(turn.answer, undefined, true);
          return;
        }
        finalize(turn.answer, error.message || '流式响应失败');
      })
      .finally(() => {
        abortRef.current = null;
        setLiveTurn(null);
        void loadSessions(agentId);
        void loadInbox();
      });

    function finalize(answer: string, error: string | undefined, interrupted = false) {
      const key = resolvedSessionId;
      if (!key) return;
      setThreads((prev) => {
        const thread = prev[key];
        if (!thread) return prev;
        return {
          ...prev,
          [key]: {
            ...thread,
            messages: thread.messages.map((message) =>
              message.id === assistantMessage.id
                ? { ...message, text: answer, thinking: turn.thinking || undefined, streaming: false, error, ...(interrupted ? { interrupted: true } : {}), model: turn.model, usage: turn.usage }
                : message,
            ),
          },
        };
      });
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

  const threadMessages: ChatMessage[] = (() => {
    if (!currentSessionId) return [];
    const base = currentThread?.messages ?? [];
    if (!liveTurn) return base;
    return base.map((message) =>
      message.id === liveTurn.messageId
        ? { ...message, text: liveTurn.answer, thinking: liveTurn.thinking || undefined, streaming: true, ...(liveTurn.retry ? { retry: liveTurn.retry } : {}) }
        : message,
    );
  })();

  const showWelcome = !currentSessionId;

  return (
    <MotionConfig reducedMotion="user">
      <div className="app-shell">
        <Sidebar
          agents={workspace.agents}
          currentAgentId={currentAgentId}
          collapsed={sidebarCollapsed}
          inboxOpen={inboxOpen}
          inboxCount={inboxItems.length}
          attentionByAgent={attentionByAgent}
          exploreView={exploreView}
          systemView={systemView}
          workspaceInfo={settings ? `${settings.workspace.name} · ${settings.workspace.sessionDir}` : undefined}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onSelectAgent={selectAgent}
          onOpenConfig={setConfigAgentId}
          onNewAgent={() => openExplore('templates')}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onOpenInbox={() => { setView({ kind: 'inbox' }); void loadInbox(); }}
          onCloseInbox={() => setView({ kind: 'chat' })}
          onOpenExplore={openExplore}
          onOpenSystem={openSystem}
        />

        {!exploreView && !systemView && !inboxOpen && currentAgent && (
          <InboxColumn
            title={currentAgent.name}
            sessions={sessions}
            currentSessionId={currentSessionId}
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
          {!exploreView && !systemView && !inboxOpen && <UsageBar agent={currentAgent} sessions={sessions} />}

          {exploreView === 'agents' ? (
            <ExploreAgents agents={workspace.agents} onOpenChat={selectAgent} />
          ) : exploreView === 'templates' ? (
            <TemplatesView onCreated={() => void handleAgentCreated()} />
          ) : exploreView === 'skills' ? (
            <SkillsView prompts={workspace.prompts} />
          ) : systemView === 'usage' ? (
            <UsageView usage={usage} loading={usageLoading} onRefresh={() => void loadUsage()} />
          ) : systemView === 'settings' ? (
            <SettingsView settings={settings} loading={settingsLoading} preferences={uiPreferences} onPreferenceChange={handlePreferenceChange} />
          ) : inboxOpen ? (
            <InboxView
              items={inboxItems}
              agents={workspace.agents}
              loading={inboxLoading}
              onRefresh={() => void loadInbox()}
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
                      className={configAgentId ? 'header-button active' : 'header-button'}
                      onClick={() => setConfigAgentId((prev) => (prev ? null : currentAgentId))}
                    >
                      <SlidersHorizontal size={13} />
                      配置
                    </button>
                  )}
                </div>
              )}

              {showWelcome && currentAgent ? (
                <>
                  <Welcome agent={currentAgent} onSuggestion={send} />
                  <div className="composer-wrap welcome-composer">
                    <Composer
                      prompts={workspace.prompts}
                      models={workspace.models}
                      disabled={Boolean(liveTurn)}
                      selectedModel={selectedModel}
                      onSelectModel={setSelectedModel}
                      onSend={send}
                    />
                  </div>
                </>
              ) : (
                <>
                  <ThreadView messages={threadMessages} compact={uiPreferences.compactMessages} />
                  <div className="composer-wrap">
                    <div className="composer-inner">
                      <Composer
                        prompts={workspace.prompts}
                        models={workspace.models}
                        disabled={Boolean(liveTurn)}
                        queued={Boolean(liveTurn)}
                        selectedModel={selectedModel}
                        onSelectModel={setSelectedModel}
                        onSend={send}
                      />
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </main>

        <CommandPalette
          open={paletteOpen}
          agents={workspace.agents}
          sessionsByAgent={sessionsByAgent}
          onAction={handlePaletteAction}
          onClose={() => setPaletteOpen(false)}
        />
        <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

        <AnimatePresence>
          {configAgentId && (
            <ConfigPanel
              agentId={configAgentId}
              models={workspace.models}
              onClose={() => setConfigAgentId(null)}
              onUseSuggestion={(text) => { setConfigAgentId(null); send(text); }}
            />
          )}
        </AnimatePresence>

        <Toasts toasts={toasts} />
      </div>
    </MotionConfig>
  );
}

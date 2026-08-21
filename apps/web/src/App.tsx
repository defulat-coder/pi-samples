import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary, ChatStreamEvent, SessionSummary, WorkspaceResponse } from '@pi-workbench/contracts';
import { AnimatePresence, MotionConfig } from 'motion/react';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { SlidersHorizontal } from '@phosphor-icons/react/dist/icons/SlidersHorizontal';
import { deleteSession, fetchSessions, fetchWorkspace, renameSession, streamChat } from './lib/api.js';
import { createLiveTurn, reduceStreamEvent, type LiveTurn } from './lib/stream.js';
import { sortSessions } from './lib/sessions.js';
import { newMessageId, type ChatMessage } from './lib/types.js';
import { Sidebar } from './components/Sidebar.js';
import { UsageBar } from './components/UsageBar.js';
import { Welcome } from './components/Welcome.js';
import { Composer } from './components/Composer.js';
import { ThreadView } from './components/ThreadView.js';
import { ConfigPanel } from './components/ConfigPanel.js';

type ThreadState = {
  messages: ChatMessage[];
  /** true 表示该会话是本次页面加载之前创建的，历史消息不在内存中。 */
  historyUnavailable: boolean;
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [configAgentId, setConfigAgentId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const currentAgent: AgentSummary | undefined = workspace?.agents.find((agent) => agent.id === currentAgentId);
  const sessions = useMemo(
    () => (currentAgentId ? sortSessions(sessionsByAgent[currentAgentId] ?? []) : []),
    [sessionsByAgent, currentAgentId],
  );
  const currentThread: ThreadState | undefined = currentSessionId ? threads[currentSessionId] : undefined;

  const loadSessions = useCallback(async (agentId: string) => {
    try {
      const items = await fetchSessions(agentId);
      setSessionsByAgent((prev) => ({ ...prev, [agentId]: items }));
    } catch {
      // 会话列表失败不阻塞主界面。
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
    } catch (error) {
      setFatal(error instanceof Error ? error.message : '工作区信息暂时无法读取');
    }
  }, [loadSessions]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  const selectAgent = (agentId: string) => {
    if (agentId === currentAgentId) return;
    abortRef.current?.abort();
    setLiveTurn(null);
    setCurrentAgentId(agentId);
    setCurrentSessionId(null);
    setConfigAgentId(null);
    if (!sessionsByAgent[agentId]) void loadSessions(agentId);
  };

  const selectSession = (sessionId: string) => {
    if (sessionId === currentSessionId) return;
    setCurrentSessionId(sessionId);
    setThreads((prev) => prev[sessionId] ? prev : { ...prev, [sessionId]: { messages: [], historyUnavailable: true } });
  };

  const newSession = () => {
    setCurrentSessionId(null);
    setConfigAgentId(null);
  };

  const handleRename = async (sessionId: string, title: string) => {
    if (!currentAgentId) return;
    try {
      await renameSession(currentAgentId, sessionId, title);
      await loadSessions(currentAgentId);
    } catch {
      // 失败时保留旧标题。
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
    } catch {
      // 删除失败时列表保持原样。
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
        const thread = prev[key] ?? { messages: [], historyUnavailable: false };
        return { ...prev, [key]: { ...thread, messages: [...thread.messages, ...items], historyUnavailable: false } };
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
      { agentId, message: text, ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}), ...(selectedModel ? { model: selectedModel } : {}) },
      onEvent,
      controller.signal,
    )
      .then((done) => {
        finalize(turn.answer || done.answer, undefined);
      })
      .catch((error: Error) => {
        if (controller.signal.aborted) return;
        finalize(turn.answer, error.message || '流式响应失败');
      })
      .finally(() => {
        abortRef.current = null;
        setLiveTurn(null);
        void loadSessions(agentId);
      });

    function finalize(answer: string, error: string | undefined) {
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
                ? { ...message, text: answer, thinking: turn.thinking || undefined, streaming: false, error, model: turn.model, usage: turn.usage }
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
        ? { ...message, text: liveTurn.answer, thinking: liveTurn.thinking || undefined, streaming: true }
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
          sessions={sessions}
          currentSessionId={currentSessionId}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((value) => !value)}
          onSelectAgent={selectAgent}
          onSelectSession={selectSession}
          onNewSession={newSession}
          onRenameSession={(id, title) => void handleRename(id, title)}
          onDeleteSession={(id) => void handleDelete(id)}
          onOpenConfig={setConfigAgentId}
        />

        <main className="main-area">
          <UsageBar agent={currentAgent} sessions={sessions} />

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
              <ThreadView messages={threadMessages} historyUnavailable={Boolean(currentThread?.historyUnavailable)} />
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
        </main>

        <AnimatePresence>
          {configAgentId && (
            <ConfigPanel
              agentId={configAgentId}
              onClose={() => setConfigAgentId(null)}
              onUseSuggestion={(text) => { setConfigAgentId(null); send(text); }}
            />
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

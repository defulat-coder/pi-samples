import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AgentChatResponse, AgentChatStreamEvent, AgentEventSummary, AgentFeedback, AgentResourceDocument, AgentResourceSummary, AgentSessionListResponse, AgentSessionMessage, AgentSessionRecord } from '@pi-workbench/contracts';
import {
  ArrowUpRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  ChatCircle,
  Copy,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  Plus,
  ThumbsDown,
  ThumbsUp,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type UserMessageItem = Extract<AgentSessionMessage, { kind: 'user' }>;
type ThinkingMessageItem = Extract<AgentSessionMessage, { kind: 'thinking' }>;
type AssistantMessageItem = Extract<AgentSessionMessage, { kind: 'assistant' }>;

/** The stream's semantic output stays split into sibling UI items. */
type ConversationItem = AgentSessionMessage;

type WorkspaceSnapshot = {
  resources: AgentResourceSummary[];
  tools: { enabled: string[]; policy: 'read-only' };
  model: { enabled: boolean; providerConfigured: boolean; provider?: string; model?: string; thinkingLevel?: string };
};

type FileTreeNode = {
  name: string;
  path: string;
  kind: 'folder' | 'file';
  children: FileTreeNode[];
  fileCount: number;
  searchText: string;
  resource?: AgentResourceSummary;
};

type SessionRecord = AgentSessionRecord;

type WorkspaceView = 'sessions' | 'files';

const fallbackResources: AgentResourceSummary[] = [
  { path: '.pi/skills/pi-workbench/SKILL.md', kind: 'skill', title: 'Pi 工作台智能体技能', status: 'active' },
  { path: '.pi/prompts/agent-chat.md', kind: 'prompt', title: '智能体对话提示词', status: 'active' },
  { path: '.pi/knowledge/agent/session-lifecycle.md', kind: 'knowledge', title: 'Pi 会话生命周期', status: 'active' },
  { path: '.pi/knowledge/agent/resource-loading.md', kind: 'knowledge', title: '项目资源加载', status: 'active' },
  { path: '.pi/knowledge/agent/tool-policy.md', kind: 'knowledge', title: '只读工具策略', status: 'active' },
  { path: '.pi/knowledge/agent/answer-contract.md', kind: 'knowledge', title: '智能体回答契约', status: 'active' },
  { path: '.pi/knowledge/agent/local-fallback.md', kind: 'knowledge', title: '本地降级模式', status: 'active' },
];

const fallbackWorkspace: WorkspaceSnapshot = {
  resources: fallbackResources,
  tools: { enabled: ['read', 'search_knowledge'], policy: 'read-only' },
  model: { enabled: false, providerConfigured: false, provider: 'kimi-coding', model: 'kimi-for-coding', thinkingLevel: 'low' },
};

function newSessionId() {
  return `session_${Math.random().toString(36).slice(2, 10)}`;
}

function sessionTitle(messages: ConversationItem[]) {
  const firstUserMessage = messages.find((message): message is UserMessageItem => message.kind === 'user')?.text.trim();
  return firstUserMessage ? firstUserMessage.slice(0, 34) : '新对话';
}

function routeLabel(route: AgentChatResponse['route']) {
  return route === 'knowledge' ? '知识库' : '工作区';
}

function responseSourceLabel(source: AgentChatResponse['source']) {
  return source === 'pi-coding-agent' ? 'Pi 会话' : '本地降级';
}

function resourceTitle(title: string) {
  return title
    .replace(/Pi Workbench Agent Skill/g, 'Pi 工作台智能体技能')
    .replace(/\bWorkbench\b/g, '工作台')
    .replace(/\bAgent\b/g, '智能体')
    .replace(/\bSession\b/g, '会话')
    .replace(/\bSkill\b/g, '技能')
    .replace(/\bPrompt\b/g, '提示词')
    .replace(/\bKnowledge\b/g, '知识');
}

function parseStreamPayload(eventName: string, data: string): AgentChatStreamEvent {
  const payload = JSON.parse(data) as Record<string, unknown>;
  if (eventName === 'start') return { type: 'start', sessionId: String(payload.sessionId), model: payload.model as AgentChatResponse['model'] };
  if (eventName === 'event') return { type: 'event', event: payload.event as AgentEventSummary };
  if (eventName === 'text_delta') return { type: 'text_delta', delta: String(payload.delta ?? '') };
  if (eventName === 'thinking_delta') return { type: 'thinking_delta', delta: String(payload.delta ?? '') };
  if (eventName === 'done') return { type: 'done', response: payload.response as AgentChatResponse };
  if (eventName === 'error') return { type: 'error', message: String(payload.message ?? '智能体流式响应失败') };
  throw new Error(`未知的流式事件：${eventName}`);
}

async function consumeAgentStream(response: Response, onEvent: (event: AgentChatStreamEvent) => void): Promise<AgentChatResponse> {
  if (!response.body) throw new Error('智能体网关没有返回可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: AgentChatResponse | undefined;

  const consumeBlock = (block: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) return;
    const event = parseStreamPayload(eventName, dataLines.join('\n'));
    onEvent(event);
    if (event.type === 'error') throw new Error(event.message);
    if (event.type === 'done') finalResponse = event.response;
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      consumeBlock(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) consumeBlock(buffer);
  if (!finalResponse) throw new Error('智能体流在完成事件前结束');
  return finalResponse;
}

async function fetchSessionRecords(): Promise<SessionRecord[]> {
  const response = await fetch('/api/v1/agent/sessions');
  if (!response.ok) throw new Error('会话列表暂时无法读取');
  const payload = await response.json() as AgentSessionListResponse;
  return payload.items;
}

async function createSessionRecord(): Promise<SessionRecord> {
  const response = await fetch('/api/v1/agent/sessions', { method: 'POST' });
  if (!response.ok) throw new Error('新建会话失败');
  return response.json() as Promise<SessionRecord>;
}

async function fetchSessionRecord(id: string): Promise<SessionRecord> {
  const response = await fetch(`/api/v1/agent/sessions/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error('会话内容暂时无法读取');
  return response.json() as Promise<SessionRecord>;
}

function buildFileTree(resources: AgentResourceSummary[]): FileTreeNode {
  const root: FileTreeNode = { name: '.pi', path: '.pi', kind: 'folder', children: [], fileCount: 0, searchText: '' };
  for (const resource of resources) {
    const parts = resource.path.split('/')[0] === '.pi' ? resource.path.split('/').slice(1) : resource.path.split('/');
    let cursor = root;
    parts.forEach((part, index) => {
      const path = [root.path, ...parts.slice(0, index + 1)].join('/');
      const isFile = index === parts.length - 1;
      let child = cursor.children.find((item) => item.path === path);
      if (!child) {
        child = { name: part, path, kind: isFile ? 'file' : 'folder', children: [], fileCount: isFile ? 1 : 0, searchText: '', resource: isFile ? resource : undefined };
        cursor.children.push(child);
      }
      cursor = child;
    });
  }

  const sortChildren = (node: FileTreeNode) => {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      return left.name.localeCompare(right.name, 'zh-CN');
    });
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  const annotateNode = (node: FileTreeNode) => {
    const ownText = `${node.name} ${node.path} ${node.resource?.title ?? ''}`.toLocaleLowerCase();
    node.fileCount = node.kind === 'file' ? 1 : 0;
    const childSearchText: string[] = [];
    for (const child of node.children) {
      annotateNode(child);
      node.fileCount += child.fileCount;
      childSearchText.push(child.searchText);
    }
    node.searchText = [ownText, ...childSearchText].join(' ');
  };
  annotateNode(root);
  return root;
}

function collectCollapsedFolders(node: FileTreeNode, depth = 0, paths: string[] = []): string[] {
  if (node.kind === 'folder' && depth >= 2) paths.push(node.path);
  node.children.forEach((child) => collectCollapsedFolders(child, depth + 1, paths));
  return paths;
}

function treeHasMatch(node: FileTreeNode, query: string): boolean {
  return !query || node.searchText.includes(query);
}

function fileKindLabel(resource?: AgentResourceSummary) {
  if (resource?.kind === 'skill') return 'S';
  if (resource?.kind === 'prompt') return 'P';
  if (resource?.kind === 'session' || resource?.path.endsWith('.jsonl')) return 'JSONL';
  if (resource?.kind === 'file') return 'FILE';
  return 'MD';
}

type FileTreeProps = { node: FileTreeNode; depth: number; query: string; collapsedPaths: Set<string>; selectedResource: string; onToggle: (path: string) => void; onSelect: (path: string) => void };

const FileTree = memo(function FileTree({ node, depth, query, collapsedPaths, selectedResource, onToggle, onSelect }: FileTreeProps) {
  if (query && !treeHasMatch(node, query)) return null;
  const indentStyle = { '--tree-depth': depth } as CSSProperties;
  if (node.kind === 'file' && node.resource) {
    const isSelected = selectedResource === node.path;
    return <button type="button" className={isSelected ? 'tree-row tree-file selected' : 'tree-row tree-file'} style={indentStyle} onClick={() => onSelect(node.path)} title={node.path}><span className={`tree-file-kind tree-file-kind-${node.resource.kind}`}>{fileKindLabel(node.resource)}</span><span className="tree-file-copy"><strong>{node.name}</strong><small>{resourceTitle(node.resource.title)}</small></span></button>;
  }

  const isOpen = Boolean(query) || !collapsedPaths.has(node.path);
  return <div className="tree-node"><button type="button" className="tree-row tree-folder" style={indentStyle} onClick={() => onToggle(node.path)} aria-expanded={isOpen}><span className="tree-folder-icon">{isOpen ? <FolderOpen size={16} weight="duotone" /> : <Folder size={16} weight="duotone" />}</span><span className="tree-file-copy"><strong>{node.name}</strong><small className="tree-folder-count" aria-label={`${node.fileCount} 个文件`}>{node.fileCount}</small></span>{isOpen ? <CaretDown size={13} /> : <CaretRight size={13} />}</button>{isOpen && <div className="tree-children">{node.children.map((child) => <FileTree key={child.path} node={child} depth={depth + 1} query={query} collapsedPaths={collapsedPaths} selectedResource={selectedResource} onToggle={onToggle} onSelect={onSelect} />)}</div>}</div>;
});

function SourceList({ response }: { response: AgentChatResponse }) {
  if (!response.sources.length) return <div className="empty-source">本次没有额外文件证据</div>;
  return <div className="source-list">{response.sources.map((source) => <div className="source-row" key={source.ref}><span className="source-kind">MD</span><span><strong>{resourceTitle(source.title)}</strong><small>{source.ref}</small></span></div>)}</div>;
}

function ThinkingBlock({ message }: { message: ThinkingMessageItem }) {
  if (!message.text) return null;
  const isWorking = message.status === 'streaming';
  return <section className="agent-turn-thinking" aria-label="思考过程"><details className="thinking-trace" open={isWorking}><summary><span>思考过程</span><small>{isWorking ? '进行中' : `${message.text.length} 字符`}</small></summary><pre>{message.text}</pre></details></section>;
}

function AgentToolEvents({ events, toolCalls }: { events: AgentEventSummary[]; toolCalls: string[] }) {
  const visibleEvents = events.filter((event) => event.category === 'tool' || event.category === 'error');
  if (!visibleEvents.length && !toolCalls.length) return null;
  return <section className="agent-tool-events" aria-label="工具调用"><div className="agent-content-label">工具调用</div>{visibleEvents.length ? visibleEvents.map((event, index) => <details className={event.category === 'error' ? 'agent-tool-event agent-tool-event-error' : 'agent-tool-event'} key={`${event.type}-${index}`}><summary><span className="agent-tool-event-status" aria-hidden="true" /> <span>{event.label}</span>{event.toolName && <code>{event.toolName}</code>}</summary>{event.detail && <pre>{event.detail}</pre>}</details>) : toolCalls.map((toolName, index) => <div className="agent-tool-event agent-tool-event-compact" key={`${toolName}-${index}`}><span className="agent-tool-event-status" aria-hidden="true" /><span>调用工具</span><code>{toolName}</code></div>)}</section>;
}

function formatDuration(durationMs: number) {
  if (durationMs < 1000) return `${durationMs} ms`;
  return `${(durationMs / 1000).toFixed(durationMs >= 10_000 ? 0 : 1)} s`;
}

function formatMetricTime(value: string) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
  } catch {
    return value;
  }
}

function AgentMetrics({ response }: { response: AgentChatResponse }) {
  const metrics = response.metrics;
  if (!metrics) return null;
  const tokens = metrics.tokenUsage;
  const tokenLabel = tokens.source === 'estimated' ? `${tokens.total.toLocaleString('zh-CN')}（估算）` : tokens.source === 'provider' ? tokens.total.toLocaleString('zh-CN') : '未提供';
  return <section className="agent-metrics" aria-label="执行指标">
    <div className="agent-metrics-summary" role="list" aria-label="执行指标摘要">
      <span role="listitem"><strong>第 {metrics.turn} 轮</strong></span>
      <span role="listitem">执行 {metrics.executionRounds} 轮</span>
      <span role="listitem">耗时 {formatDuration(metrics.durationMs)}</span>
      <span role="listitem">Token {tokenLabel}</span>
      <span role="listitem">工具 {metrics.toolCallCount}</span>
      <span role="listitem">事件 {metrics.eventCount}</span>
    </div>
    <details className="agent-metrics-details">
      <summary>全部指标</summary>
      <div className="agent-metrics-grid">
        <span>开始时间<strong>{formatMetricTime(metrics.startedAt)}</strong></span>
        <span>完成时间<strong>{formatMetricTime(metrics.completedAt)}</strong></span>
        <span>输入字符<strong>{metrics.inputChars.toLocaleString('zh-CN')}</strong></span>
        <span>输出字符<strong>{metrics.outputChars.toLocaleString('zh-CN')}</strong></span>
        <span>Thinking 字符<strong>{metrics.thinkingChars.toLocaleString('zh-CN')}</strong></span>
        <span>模型<strong>{response.model.model ?? '本地降级'}</strong></span>
        <span>提供方<strong>{response.model.provider ?? '本地'}</strong></span>
        <span>Thinking<strong>{response.model.thinkingLevel ?? '未提供'}</strong></span>
        <span>输入 Token<strong>{tokens.source === 'unavailable' ? '未提供' : `${tokens.input.toLocaleString('zh-CN')}${tokens.source === 'estimated' ? '（估算）' : ''}`}</strong></span>
        <span>输出 Token<strong>{tokens.source === 'unavailable' ? '未提供' : `${tokens.output.toLocaleString('zh-CN')}${tokens.source === 'estimated' ? '（估算）' : ''}`}</strong></span>
        <span>总 Token<strong>{tokenLabel}</strong></span>
      </div>
      {tokens.source === 'estimated' && <small className="agent-metrics-note">当前 Pi 运行时没有返回供应商 usage 字段，Token 按文本长度估算，仅用于观察趋势。</small>}
      {tokens.source === 'unavailable' && <small className="agent-metrics-note">这条历史消息生成时尚未保存 Token usage，因此只展示可回溯的执行指标。</small>}
    </details>
  </section>;
}

function AgentActions({ message, copiedMessageId, feedbackPending, onCopy, onFeedback }: { message: AssistantMessageItem; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void }) {
  const feedback = message.feedback ?? null;
  const feedbackReady = Boolean(message.response && message.id.startsWith('message_'));
  return <div className="agent-actions" aria-label="回答操作">
    <button type="button" className="agent-action-button" onClick={() => onCopy(message.id, message.text)} disabled={!message.text} aria-label={copiedMessageId === message.id ? '已复制回答' : '复制回答'} title={copiedMessageId === message.id ? '已复制' : '复制'}>{copiedMessageId === message.id ? <Check size={14} weight="bold" /> : <Copy size={14} />}</button>
    <span className="agent-actions-divider" aria-hidden="true" />
    <button type="button" className={feedback === 'like' ? 'agent-action-button agent-action-button-active' : 'agent-action-button'} onClick={() => onFeedback(message.id, feedback === 'like' ? null : 'like')} disabled={!feedbackReady || feedbackPending === message.id} aria-pressed={feedback === 'like'} aria-label="点赞" title="点赞"><ThumbsUp size={14} weight={feedback === 'like' ? 'fill' : 'regular'} /></button>
    <button type="button" className={feedback === 'dislike' ? 'agent-action-button agent-action-button-active' : 'agent-action-button'} onClick={() => onFeedback(message.id, feedback === 'dislike' ? null : 'dislike')} disabled={!feedbackReady || feedbackPending === message.id} aria-pressed={feedback === 'dislike'} aria-label="点踩" title="点踩"><ThumbsDown size={14} weight={feedback === 'dislike' ? 'fill' : 'regular'} /></button>
  </div>;
}

function AgentAnswer({ message, copiedMessageId, feedbackPending, onCopy, onFeedback }: { message: AssistantMessageItem; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void }) {
  const isWorking = !message.response;
  return <section className="agent-turn-answer">{message.text ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div> : isWorking && <div className="typing-line"><i /><i /><i /></div>}{message.response && <><div className="message-evidence"><div className="evidence-head"><span>依据</span><span className={`response-tag response-tag-${message.response.source === 'pi-coding-agent' ? 'live' : 'local'}`}>{responseSourceLabel(message.response.source)}</span><span className="route-tag">路径 · {routeLabel(message.response.route)}</span></div><SourceList response={message.response} /></div><AgentMetrics response={message.response} /></>}{(message.text || message.response) && <AgentActions message={message} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} />}</section>;
}

type AgentTurnMessages = { turnId: string; thinking?: ThinkingMessageItem; assistant?: AssistantMessageItem };

function AgentTurn({ thinking, assistant, showThinking, copiedMessageId, feedbackPending, onCopy, onFeedback }: { thinking?: ThinkingMessageItem; assistant?: AssistantMessageItem; showThinking: boolean; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void }) {
  const response = assistant?.response;
  const isWorking = !response;
  return <article className="agent-turn" aria-label="Pi 智能体回合"><div className="agent-turn-avatar message-avatar"><span className="agent-avatar-mark">π</span></div><div className="agent-turn-content"><div className="message-meta"><strong>Pi 智能体</strong><span>{isWorking ? '处理中' : '刚刚'}</span></div>{thinking && showThinking && <ThinkingBlock message={thinking} />}{assistant && <AgentToolEvents events={response?.events ?? []} toolCalls={response?.decision.toolCalls ?? []} />}{assistant && <AgentAnswer message={assistant} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} />}</div></article>;
}

function UserMessage({ message }: { message: UserMessageItem }) {
  return <article className="message message-user"><div className="message-body"><div className="message-meta"><strong>你</strong><span>刚刚</span></div><p>{message.text}</p></div></article>;
}

function ConversationStream({ messages, showThinking, copiedMessageId, feedbackPending, onCopy, onFeedback }: { messages: ConversationItem[]; showThinking: boolean; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void }) {
  const nodes: ReactNode[] = [];
  let turn: AgentTurnMessages | null = null;
  const flushTurn = () => {
    if (!turn) return;
    nodes.push(<AgentTurn key={`agent-turn-${turn.turnId}`} thinking={turn.thinking} assistant={turn.assistant} showThinking={showThinking} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} />);
    turn = null;
  };
  for (const message of messages) {
    if (message.kind === 'user') {
      flushTurn();
      nodes.push(<UserMessage key={message.id} message={message} />);
      continue;
    }
    if (!turn || turn.turnId !== message.turnId) {
      flushTurn();
      turn = { turnId: message.turnId };
    }
    if (message.kind === 'thinking') turn.thinking = message;
    if (message.kind === 'assistant') turn.assistant = message;
  }
  flushTurn();
  return <>{nodes}</>;
}

function ResourceViewer({ document, loading, error, onClose }: { document: AgentResourceDocument | null; loading: boolean; error: string; onClose: () => void }) {
  const isRawText = document?.resource.kind === 'session' || document?.resource.path.endsWith('.jsonl');
  return <section className="resource-viewer" aria-label="项目文件预览">
    <header className="resource-viewer-header">
      <button type="button" className="resource-viewer-close" onClick={onClose} aria-label="返回聊天" title="返回聊天"><CaretLeft size={16} /></button>
      <div className="resource-viewer-heading">
        <strong>{document?.resource.title ?? '项目文件'}</strong>
        <span>{document?.resource.path ?? '正在读取文件内容'}</span>
      </div>
      <span className="resource-viewer-kind">{document ? fileKindLabel(document.resource) : 'MD'}</span>
    </header>
    <div className="resource-viewer-scroll">
      {loading && <div className="resource-viewer-state"><strong>正在读取文件</strong><span>只读内容即将显示在这里。</span></div>}
      {!loading && error && <div className="resource-viewer-state resource-viewer-error"><strong>文件读取失败</strong><span>{error}</span><button type="button" onClick={onClose}>返回聊天</button></div>}
      {!loading && !error && document && (isRawText ? <pre className="resource-viewer-raw">{document.content}</pre> : <article className="resource-viewer-body markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{document.content}</Markdown></article>)}
    </div>
  </section>;
}

function SessionList({ sessions, currentSessionId, pending, onSelect, onNewSession }: { sessions: SessionRecord[]; currentSessionId: string; pending: boolean; onSelect: (id: string) => void; onNewSession: () => void }) {
  return <div className="workspace-session-list" aria-label="会话列表"><button type="button" className="new-session-button session-new-session" onClick={onNewSession}><Plus size={14} weight="bold" />新建会话</button>{sessions.length ? <div className="session-rows">{sessions.map((session) => { const isCurrent = session.id === currentSessionId; const messageCount = session.messages.filter((message) => message.kind === 'user').length; return <button className={isCurrent ? 'session-row session-row-current' : 'session-row'} key={session.id} onClick={() => onSelect(session.id)} disabled={pending && !isCurrent}><span className="session-row-icon"><ChatCircle size={15} weight={isCurrent ? 'fill' : 'duotone'} /></span><span className="session-row-copy"><strong>{sessionTitle(session.messages)}</strong><small>{messageCount ? `${messageCount} 次提问` : '尚未提问'}</small></span>{isCurrent && <span className="session-row-state">当前</span>}</button>; })}</div> : <div className="session-empty"><ChatCircle size={17} /><strong>暂无会话</strong><span>开始对话后，会话会显示在这里。</span></div>}</div>;
}

function WorkspacePanel({ workspace, sessions, currentSessionId, view, tree, filter, selectedResource, collapsedPaths, pending, open, onToggleOpen, onViewChange, onFilterChange, onToggle, onSelect, onSelectSession, onNewSession }: { workspace: WorkspaceSnapshot; sessions: SessionRecord[]; currentSessionId: string; view: WorkspaceView; tree: FileTreeNode; filter: string; selectedResource: string; collapsedPaths: Set<string>; pending: boolean; open: boolean; onToggleOpen: () => void; onViewChange: (view: WorkspaceView) => void; onFilterChange: (value: string) => void; onToggle: (path: string) => void; onSelect: (path: string) => void; onSelectSession: (id: string) => void; onNewSession: () => void }) {
  const showingSessions = view === 'sessions';
  return (
    <aside id="project-workspace" className={open ? 'workspace-panel' : 'workspace-panel workspace-panel-collapsed'} data-state={open ? 'expanded' : 'collapsed'} data-collapsible="icon" aria-label="项目工作区">
      <button type="button" className="workspace-toggle-button" data-sidebar="trigger" onClick={onToggleOpen} aria-controls="project-workspace" aria-expanded={open} aria-label={open ? '收起工作区' : '展开工作区'} title={open ? '收起工作区' : '展开工作区'}>
        {open ? <CaretRight size={15} /> : <CaretLeft size={15} />}
        <span className="sr-only">{open ? '收起工作区' : '展开工作区'}</span>
      </button>
      {open ? (
        <div className="workspace-panel-content">
          <header className="workspace-brand-header" aria-label="Pi 工作台">
            <div className="workspace-brand">
              <div className="workspace-brand-mark">π</div>
              <div className="workspace-brand-copy">
                <strong>Pi 工作台</strong>
                <span>本地智能体</span>
              </div>
            </div>
          </header>
          <nav className="workspace-tabs" aria-label="工作区视图" role="tablist" aria-orientation="horizontal">
            <button type="button" id="workspace-tab-sessions" role="tab" className={showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('sessions')} aria-controls="workspace-view-panel" aria-selected={showingSessions} tabIndex={showingSessions ? 0 : -1}>
              <ChatCircle size={14} weight={showingSessions ? 'fill' : 'regular'} />
              <span>会话</span>
              <small>{sessions.length}</small>
            </button>
            <button type="button" id="workspace-tab-files" role="tab" className={!showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('files')} aria-controls="workspace-view-panel" aria-selected={!showingSessions} tabIndex={showingSessions ? -1 : 0}>
              <FolderOpen size={14} weight={!showingSessions ? 'fill' : 'regular'} />
              <span>项目文件</span>
              <small>{workspace.resources.length}</small>
            </button>
          </nav>
          <div id="workspace-view-panel" className="workspace-view-panel" role="tabpanel" aria-labelledby={showingSessions ? 'workspace-tab-sessions' : 'workspace-tab-files'} tabIndex={0}>
            {showingSessions ? (
              <SessionList sessions={sessions} currentSessionId={currentSessionId} pending={pending} onSelect={onSelectSession} onNewSession={onNewSession} />
            ) : (
              <>
                <div className="workspace-toolbar">
                  <label className="workspace-search">
                    <MagnifyingGlass size={14} />
                    <input value={filter} onChange={(event) => onFilterChange(event.target.value)} placeholder="筛选文件" aria-label="过滤 .pi 文件" />
                  </label>
                </div>
                <div className="workspace-tree" aria-label="Pi 项目文件树">
                  <FileTree node={tree} depth={0} query={filter.trim().toLocaleLowerCase()} collapsedPaths={collapsedPaths} selectedResource={selectedResource} onToggle={onToggle} onSelect={onSelect} />
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(fallbackWorkspace);
  const [sessionId, setSessionId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ConversationItem[]>([]);
  const [pending, setPending] = useState(false);
  const [selectedResource, setSelectedResource] = useState(fallbackResources[0]!.path);
  const [resourceFilter, setResourceFilter] = useState('');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('files');
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [sessionRecords, setSessionRecords] = useState<SessionRecord[]>([]);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [showThinking, setShowThinking] = useState(true);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState('');
  const [feedbackPending, setFeedbackPending] = useState('');
  const [error, setError] = useState('');
  const [resourceDocument, setResourceDocument] = useState<AgentResourceDocument | null>(null);
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceError, setResourceError] = useState('');
  const resourceRequestRef = useRef(0);
  const fileTree = useMemo(() => buildFileTree(workspace.resources), [workspace.resources]);
  const sessions = sessionRecords;

  useEffect(() => {
    setCollapsedPaths(new Set(collectCollapsedFolders(fileTree)));
  }, [fileTree]);

  useEffect(() => {
    fetch('/api/v1/agent/workspace').then(async (response) => {
      if (!response.ok) throw new Error('workspace unavailable');
      return response.json() as Promise<WorkspaceSnapshot>;
    }).then(setWorkspace).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const loadSessions = async () => {
      try {
        let records = await fetchSessionRecords();
        if (!records.length) records = [await createSessionRecord()];
        if (!active) return;
        const initial = records[0]!;
        setSessionRecords(records);
        setSessionId(initial.id);
        setMessages(initial.messages);
      } catch {
        if (!active) return;
        const now = new Date().toISOString();
        const fallbackId = newSessionId();
        setSessionRecords([{ id: fallbackId, position: 0, createdAt: now, updatedAt: now, messages: [] }]);
        setSessionId(fallbackId);
        setMessages([]);
      } finally {
        if (active) setSessionsReady(true);
      }
    };
    void loadSessions();
    return () => { active = false; };
  }, []);

  async function syncSession(id: string) {
    try {
      const record = await fetchSessionRecord(id);
      setSessionRecords((current) => current.some((session) => session.id === id) ? current.map((session) => session.id === id ? record : session) : [...current, record]);
      if (id === sessionId) setMessages(record.messages);
    } catch {
      // Keep the streamed UI when persistence is temporarily unavailable.
    }
  }

  async function copyAnswer(messageId: string, text: string) {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const helper = document.createElement('textarea');
        helper.value = text;
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        document.execCommand('copy');
        helper.remove();
      }
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((current) => current === messageId ? '' : current), 1600);
    } catch {
      setError('回答复制失败，请检查浏览器剪贴板权限');
    }
  }

  async function updateFeedback(messageId: string, feedback: AgentFeedback | null) {
    if (!sessionId || !messageId.startsWith('message_')) return;
    setFeedbackPending(messageId);
    try {
      const response = await fetch(`/api/v1/agent/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/feedback`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedback }),
      });
      if (!response.ok) throw new Error('回答反馈暂时无法保存');
      const record = await response.json() as SessionRecord;
      setSessionRecords((current) => current.map((session) => session.id === record.id ? record : session));
      if (record.id === sessionId) setMessages(record.messages);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '回答反馈暂时无法保存');
    } finally {
      setFeedbackPending('');
    }
  }

  async function resetSession() {
    if (pending || !sessionsReady) return;
    let record: SessionRecord;
    try {
      record = await createSessionRecord();
    } catch {
      const now = new Date().toISOString();
      record = { id: newSessionId(), position: sessionRecords.length, createdAt: now, updatedAt: now, messages: [] };
    }
    setSessionRecords((current) => [...current, record]);
    setSessionId(record.id);
    setMessages(record.messages);
    setError('');
    closeResourceViewer();
  }

  function selectSession(nextSessionId: string) {
    if (pending || nextSessionId === sessionId) return;
    const target = sessionRecords.find((session) => session.id === nextSessionId);
    if (!target) return;
    setSessionId(target.id);
    setMessages(target.messages);
    setError('');
    closeResourceViewer();
  }

  function togglePath(path: string) {
    setCollapsedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }

  function openWorkspace(view: WorkspaceView) {
    setWorkspaceView(view);
    setWorkspaceOpen(true);
  }

  async function openResource(path: string) {
    const requestId = resourceRequestRef.current + 1;
    resourceRequestRef.current = requestId;
    setSelectedResource(path);
    setResourceDocument(null);
    setResourceError('');
    setResourceLoading(true);
    try {
      const response = await fetch(`/api/v1/agent/resource?path=${encodeURIComponent(path)}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message ?? '项目文件暂时无法读取');
      }
      const document = await response.json() as AgentResourceDocument;
      if (requestId !== resourceRequestRef.current) return;
      setResourceDocument(document);
    } catch (requestError) {
      if (requestId !== resourceRequestRef.current) return;
      setResourceError(requestError instanceof Error ? requestError.message : '项目文件暂时无法读取');
    } finally {
      if (requestId === resourceRequestRef.current) setResourceLoading(false);
    }
  }

  function closeResourceViewer() {
    resourceRequestRef.current += 1;
    setResourceDocument(null);
    setResourceLoading(false);
    setResourceError('');
  }

  async function send(message = prompt) {
    const text = message.trim();
    if (!text || pending || !sessionsReady || !sessionId) return;
    const userId = `${Date.now()}-user`;
    const thinkingId = `${Date.now()}-thinking`;
    const assistantId = `${Date.now()}-assistant`;
    const optimisticUser: UserMessageItem = { id: userId, kind: 'user', text, turnId: assistantId };
    setPrompt('');
    setError('');
    setMessages((current) => [...current, optimisticUser, { id: thinkingId, kind: 'thinking', turnId: assistantId, text: '', status: 'streaming' }, { id: assistantId, kind: 'assistant', turnId: assistantId, text: '' }]);
    setSessionRecords((current) => current.map((session) => session.id === sessionId ? { ...session, messages: [...session.messages, optimisticUser] } : session));
    setPending(true);
    let streamedAnswer = '';
    let streamedThinking = '';
    let streamFrame: number | null = null;
    const flushStream = () => {
      streamFrame = null;
      setMessages((current) => current.map((item) => {
        if (item.id === thinkingId && item.kind === 'thinking') return { ...item, text: streamedThinking };
        if (item.id === assistantId && item.kind === 'assistant') return { ...item, text: streamedAnswer };
        return item;
      }));
    };
    const scheduleStreamFlush = () => {
      if (streamFrame === null) streamFrame = window.requestAnimationFrame(flushStream);
    };
    const cancelStreamFlush = () => {
      if (streamFrame !== null) window.cancelAnimationFrame(streamFrame);
      streamFrame = null;
    };
    try {
      const response = await fetch('/api/v1/agent/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ message: text, sessionId, turnId: assistantId, debug: true }) });
      if (!response.ok) throw new Error('智能体网关返回错误');
      const data = await consumeAgentStream(response, (event) => {
        if (event.type === 'text_delta') {
          streamedAnswer += event.delta;
          scheduleStreamFlush();
        }
        if (event.type === 'thinking_delta') {
          streamedThinking += event.delta;
          scheduleStreamFlush();
        }
      });
      cancelStreamFlush();
      setMessages((current) => current.map((item) => {
        if (item.id === thinkingId && item.kind === 'thinking') return { ...item, status: 'complete', text: streamedThinking };
        if (item.id === assistantId && item.kind === 'assistant') return { ...item, text: data.answer, response: data };
        return item;
      }));
      await syncSession(sessionId);
    } catch (requestError) {
      cancelStreamFlush();
      setError(requestError instanceof Error ? requestError.message : '智能体网关暂时不可用');
      void syncSession(sessionId);
    } finally {
      cancelStreamFlush();
      setPending(false);
    }
  }

  return (
    <div className={workspaceOpen ? 'workbench-shell' : 'workbench-shell workbench-shell-workspace-collapsed'}>
      <main className="session-panel">
        {resourceDocument || resourceLoading || resourceError ? <ResourceViewer document={resourceDocument} loading={resourceLoading} error={resourceError} onClose={closeResourceViewer} /> : <section className="conversation-stage">
          <div className="conversation-scroll">
            {messages.length === 0 ? (
              <div className="welcome-state">
                <div className="welcome-mark"><span className="pi-welcome-glyph">π</span></div>
                <h1>你好，我是 Pi</h1>
                <p>连接本地文件和知识库，开始一次 Pi 会话。</p>
              </div>
            ) : (
              <div className="message-list">
                <ConversationStream messages={messages} showThinking={showThinking} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={copyAnswer} onFeedback={updateFeedback} />
              </div>
            )}
          </div>
          <div className="composer-wrap">
            <div className="composer">
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={sessionsReady ? '向项目提问…' : '正在加载会话…'} aria-label="向项目提问" rows={1} disabled={!sessionsReady || pending} />
              <div className="composer-toolbar">
                <button type="button" className="composer-tool-button" onClick={() => openWorkspace('files')}><FolderOpen size={14} />项目文件</button>
                <button type="button" className={showThinking ? 'composer-tool-button composer-tool-active' : 'composer-tool-button'} onClick={() => setShowThinking((visible) => !visible)} aria-pressed={showThinking} aria-label={showThinking ? '隐藏思考过程' : '显示思考过程'} title={showThinking ? '隐藏思考过程' : '显示思考过程'}>{showThinking ? '隐藏思考' : '显示思考'}</button>
                <span className="composer-toolbar-spacer" />
                <div className="composer-more-wrap">
                  <button type="button" className={modelMenuOpen ? 'composer-tool-button composer-tool-active' : 'composer-tool-button'} onClick={() => setModelMenuOpen((openState) => !openState)} aria-expanded={modelMenuOpen} aria-controls="model-selection-menu" aria-label={`当前模型 ${workspace.model.model ?? '本地降级'}`} title="查看当前模型" aria-haspopup="dialog"><span className="model-choice-label">{workspace.model.model ?? '本地降级'}</span><CaretDown size={12} /></button>
                  {modelMenuOpen && <div id="model-selection-menu" className="composer-more-menu model-selection-menu" role="dialog" aria-labelledby="model-selection-title"><strong id="model-selection-title">当前模型</strong><span>{workspace.model.model ?? '本地降级模式'}</span><small>{workspace.model.providerConfigured ? '已配置模型密钥' : '本地降级模式'}</small></div>}
                </div>
                <button type="button" className="send-button" onClick={() => void send()} disabled={pending || !sessionsReady || !prompt.trim()} aria-label="发送"><ArrowUpRight size={18} weight="bold" /></button>
              </div>
            </div>
            <div className="composer-foot"><span>按 Enter 发送 · Shift + Enter 换行</span><span><span className="composer-lock" />只读上下文</span></div>
          </div>
        </section>}
      </main>
      <WorkspacePanel workspace={workspace} sessions={sessions} currentSessionId={sessionId} view={workspaceView} tree={fileTree} filter={resourceFilter} selectedResource={selectedResource} collapsedPaths={collapsedPaths} pending={pending} open={workspaceOpen} onToggleOpen={() => setWorkspaceOpen((openState) => !openState)} onViewChange={setWorkspaceView} onFilterChange={setResourceFilter} onToggle={togglePath} onSelect={openResource} onSelectSession={selectSession} onNewSession={resetSession} />
      {error && <div className="error-toast" role="alert"><WarningCircle size={17} weight="fill" /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={14} /></button></div>}
    </div>
  );
}

import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AgentChatResponse, AgentChatStreamEvent, AgentEventSummary, AgentFeedback, AgentResourceDocument, AgentResourceSummary, AgentSessionListResponse, AgentSessionMessage, AgentSessionRecord, AuthStatusResponse, AuthUser, PiRuntimeResourceSnapshot } from '@pi-workbench/contracts';
import {
  ArrowRight,
  ArrowUpRight,
  ArrowsClockwise,
  Buildings,
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
  SignOut,
  ShieldCheck,
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
  pi?: PiRuntimeResourceSnapshot;
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

async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const response = await fetch('/api/v1/auth/status', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('登录服务暂时无法连接');
  return response.json() as Promise<AuthStatusResponse>;
}

function authErrorLabel(error: string) {
  const labels: Record<string, string> = {
    access_denied: '你取消了飞书授权，可以准备好后再次登录。',
    feishu_callback_missing_code: '飞书没有返回授权码，请重新发起登录。',
    feishu_callback_failed: '飞书登录没有完成，请检查应用配置和回调地址后重试。',
  };
  return labels[error] ?? '登录没有完成，请重试。';
}

function AuthLoadingScreen() {
  return <main className="auth-loading" aria-live="polite"><span className="auth-loading-mark">π</span><strong>正在检查登录状态</strong><span>马上回到 Pi 工作台。</span></main>;
}

function FeishuLoginPage({ status, error, onRetry }: { status: AuthStatusResponse; error: string; onRetry: () => void }) {
  const [starting, setStarting] = useState(false);
  const configured = status.configured;
  return <div className="auth-shell">
    <section className="auth-context" aria-labelledby="auth-context-title">
      <header className="auth-brand"><span className="auth-brand-mark">π</span><span><strong>Pi 工作台</strong><small>本地智能体工作区</small></span></header>
      <div className="auth-context-body">
        <h1 id="auth-context-title">先确认身份，<br /><span>再把项目交给 Pi。</span></h1>
        <p>使用飞书账号进入一个只读、可追溯的项目上下文。文件、提示词、知识库和每次会话，都在同一个工作台里保持清晰。</p>
        <ol className="auth-flow" aria-label="登录后的工作流">
          <li><span className="auth-flow-index">1</span><div><strong>飞书身份</strong><small>确认你是谁</small></div></li>
          <li><span className="auth-flow-index">2</span><div><strong>项目上下文</strong><small>读取已配置资源</small></div></li>
          <li><span className="auth-flow-index">3</span><div><strong>Pi 会话</strong><small>开始对话与检索</small></div></li>
        </ol>
      </div>
      <footer className="auth-context-foot"><span>PC 工作台</span><span>·</span><span>文件优先</span><span>·</span><span>本地运行</span></footer>
    </section>
    <main className="auth-panel" aria-labelledby="auth-title">
      <div className="auth-panel-inner">
        <div className="auth-provider-mark" aria-hidden="true"><Buildings size={22} weight="duotone" /></div>
        <h2 id="auth-title">登录 Pi 工作台</h2>
        <p className="auth-panel-lead">使用飞书账号继续你的项目会话</p>
        {error && <div className="auth-feedback auth-feedback-error" role="alert"><WarningCircle size={17} weight="fill" /><span>{authErrorLabel(error)}</span></div>}
        <button type="button" className="feishu-login-button" onClick={() => { setStarting(true); window.location.assign('/api/v1/auth/feishu/start'); }} disabled={!configured || starting} aria-busy={starting}>
          <Buildings size={19} weight="duotone" /><span>{starting ? '正在打开飞书…' : '使用飞书登录'}</span><ArrowRight size={16} />
        </button>
        {!configured ? <div className="auth-feedback auth-feedback-config" role="status"><strong>等待配置飞书应用</strong><span>{status.message ?? '服务端还没有配置飞书应用凭据。'}</span><code>FEISHU_APP_ID</code><code>FEISHU_APP_SECRET</code></div> : <p className="auth-configured-note">将跳转到飞书完成授权，授权完成后自动返回这里。</p>}
        <div className="auth-trust"><ShieldCheck size={17} weight="duotone" /><span>授权凭据只保存在 API 服务端，浏览器仅持有 HttpOnly 登录 Cookie。</span></div>
        <button type="button" className="auth-retry-button" onClick={onRetry}>重新检查登录状态</button>
      </div>
    </main>
  </div>;
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
  if (resource?.kind === 'extension') return 'EXT';
  if (resource?.kind === 'theme') return 'THEME';
  if (resource?.kind === 'settings') return 'CFG';
  if (resource?.kind === 'system') return 'SYS';
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
  return <section className="agent-turn-thinking" aria-label="思考过程" aria-busy={isWorking} aria-live={isWorking ? 'polite' : undefined}><details className="thinking-trace" open={isWorking}><summary><span className="thinking-trace-title"><i className={isWorking ? 'thinking-trace-dot thinking-trace-dot-active' : 'thinking-trace-dot'} aria-hidden="true" />思考过程</span><small>{isWorking ? '进行中' : `${message.text.length} 字符`}</small></summary><pre>{message.text}</pre></details></section>;
}

function AgentToolEvents({ events, toolCalls, toolMetrics }: { events: AgentEventSummary[]; toolCalls: string[]; toolMetrics: NonNullable<NonNullable<AgentChatResponse['metrics']>['toolMetrics']> }) {
  const visibleEvents = events.filter((event) => event.category === 'tool' || event.category === 'error');
  if (!visibleEvents.length && !toolCalls.length && !toolMetrics.length) return null;
  return <section className="agent-tool-events" aria-label="工具调用"><div className="agent-content-label">工具调用</div>{visibleEvents.length ? visibleEvents.map((event, index) => <details className={event.category === 'error' ? 'agent-tool-event agent-tool-event-error' : 'agent-tool-event'} key={`${event.type}-${index}`}><summary><span className="agent-tool-event-status" aria-hidden="true" /> <span>{event.label}</span>{event.toolName && <code>{event.toolName}</code>}<small>{event.elapsedMs !== undefined ? `+${formatDuration(event.elapsedMs)}` : ''}</small></summary>{event.detail && <pre>{event.detail}</pre>}</details>) : toolCalls.map((toolName, index) => <div className="agent-tool-event agent-tool-event-compact" key={`${toolName}-${index}`}><span className="agent-tool-event-status" aria-hidden="true" /><span>调用工具</span><code>{toolName}</code></div>)}{toolMetrics.length > 0 && <details className="agent-tool-metrics"><summary>工具执行指标 <small>{toolMetrics.length} 次</small></summary><div className="agent-tool-metric-list">{toolMetrics.map((metric, index) => <div className={metric.status === 'error' ? 'agent-tool-metric agent-tool-metric-error' : 'agent-tool-metric'} key={`${metric.toolCallId ?? metric.toolName}-${index}`}><strong>{metric.toolName}</strong><span>{metric.status === 'error' ? '失败' : '完成'}</span><small>{metric.durationMs !== undefined ? formatDuration(metric.durationMs) : '—'} · 输入 {metric.inputChars.toLocaleString('zh-CN')} 字符 · 输出 {metric.outputChars.toLocaleString('zh-CN')} 字符</small></div>)}</div></details>}</section>;
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
  const contextLabel = metrics.contextUsage?.tokens === null || metrics.contextUsage?.tokens === undefined ? '未知' : `${metrics.contextUsage.tokens.toLocaleString('zh-CN')} / ${metrics.contextUsage.contextWindow.toLocaleString('zh-CN')}`;
  const sessionTotals = metrics.sessionTotals;
  return <section className="agent-metrics" aria-label="执行指标">
    <div className="agent-metrics-summary" role="list" aria-label="执行指标摘要">
      <span role="listitem"><strong>第 {metrics.turn} 轮</strong></span>
      <span role="listitem">执行 {metrics.executionRounds} 轮</span>
      <span role="listitem">耗时 {formatDuration(metrics.durationMs)}</span>
      <span role="listitem">Token {tokenLabel}</span>
      <span role="listitem">工具 {metrics.toolCallCount}/{metrics.toolResultCount}</span>
      <span role="listitem">重试 {metrics.retryCount}</span>
      <span role="listitem">压缩 {metrics.compactionCount}</span>
      <span role="listitem">上下文 {contextLabel}</span>
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
        <span>API<strong>{response.model.api ?? '—'}</strong></span>
        <span>响应模型<strong>{response.model.responseModel ?? '—'}</strong></span>
        <span>响应 ID<strong>{response.model.responseId ?? '—'}</strong></span>
        <span>Thinking<strong>{response.model.thinkingLevel ?? '未提供'}</strong></span>
        <span>输入 Token<strong>{tokens.source === 'unavailable' ? '未提供' : `${tokens.input.toLocaleString('zh-CN')}${tokens.source === 'estimated' ? '（估算）' : ''}`}</strong></span>
        <span>输出 Token<strong>{tokens.source === 'unavailable' ? '未提供' : `${tokens.output.toLocaleString('zh-CN')}${tokens.source === 'estimated' ? '（估算）' : ''}`}</strong></span>
        <span>总 Token<strong>{tokenLabel}</strong></span>
        <span>缓存读取<strong>{tokens.cacheRead.toLocaleString('zh-CN')}</strong></span>
        <span>缓存写入<strong>{tokens.cacheWrite.toLocaleString('zh-CN')}</strong></span>
        <span>Reasoning<strong>{tokens.reasoning?.toLocaleString('zh-CN') ?? '未提供'}</strong></span>
        <span>成本<strong>{tokens.cost.total ? tokens.cost.total.toFixed(6) : '0'}</strong></span>
        <span>工具失败<strong>{metrics.toolErrorCount}</strong></span>
        <span>队列更新<strong>{metrics.queueUpdateCount}</strong></span>
        <span>Settled<strong>{metrics.settled ? '是' : '否'}</strong></span>
        <span>停止原因<strong>{metrics.stopReason ?? '未提供'}</strong></span>
        {sessionTotals && <><span>Session 消息<strong>{sessionTotals.totalMessages}</strong></span><span>Session Token<strong>{sessionTotals.tokenUsage.total.toLocaleString('zh-CN')}</strong></span><span>Session 成本<strong>{sessionTotals.cost ? sessionTotals.cost.toFixed(6) : '0'}</strong></span></>}
      </div>
      {Object.keys(metrics.eventCounts).length > 0 && <div className="agent-event-counts"><span>事件分布</span>{Object.entries(metrics.eventCounts).map(([name, count]) => <code key={name}>{name} × {count}</code>)}</div>}
      {metrics.compactions.length > 0 && <div className="agent-metric-list"><span>压缩记录</span>{metrics.compactions.map((item, index) => <small key={`${item.reason}-${index}`}>{item.reason} · {item.tokensBefore?.toLocaleString('zh-CN') ?? '未知'} → {item.estimatedTokensAfter?.toLocaleString('zh-CN') ?? '未知'} · {item.durationMs !== undefined ? formatDuration(item.durationMs) : '—'}</small>)}</div>}
      {metrics.retries.length > 0 && <div className="agent-metric-list"><span>重试记录</span>{metrics.retries.map((item, index) => <small key={`${item.kind}-${item.attempt}-${index}`}>{item.kind} {item.attempt}/{item.maxAttempts} · {item.success === false ? '失败' : item.success === true ? '成功' : '进行中'} · {item.durationMs !== undefined ? formatDuration(item.durationMs) : '—'}</small>)}</div>}
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
  return <section className="agent-turn-answer" aria-live={isWorking ? 'polite' : undefined} aria-busy={isWorking}>{message.text ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div> : isWorking && <div className="typing-line" aria-label="正在生成回答"><i /><i /><i /></div>}{message.response && <><div className="message-evidence"><div className="evidence-head"><span>依据</span><span className={`response-tag response-tag-${message.response.source === 'pi-coding-agent' ? 'live' : 'local'}`}>{responseSourceLabel(message.response.source)}</span><span className="route-tag">路径 · {routeLabel(message.response.route)}</span></div><SourceList response={message.response} /></div><AgentMetrics response={message.response} /></>}{(message.text || message.response) && <AgentActions message={message} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} />}</section>;
}

type AgentTurnMessages = { turnId: string; thinking?: ThinkingMessageItem; assistant?: AssistantMessageItem };

function AgentTurn({ thinking, assistant, showThinking, copiedMessageId, feedbackPending, onCopy, onFeedback }: { thinking?: ThinkingMessageItem; assistant?: AssistantMessageItem; showThinking: boolean; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void }) {
  const response = assistant?.response;
  const isWorking = !response;
  return <article className="agent-turn" aria-label="Pi 智能体回合"><div className="agent-turn-avatar message-avatar"><span className="agent-avatar-mark">π</span></div><div className="agent-turn-content"><div className="message-meta"><strong>Pi 智能体</strong><span>{isWorking ? '处理中' : '刚刚'}</span></div>{thinking && showThinking && <ThinkingBlock message={thinking} />}{assistant && <AgentToolEvents events={response?.events ?? []} toolCalls={response?.decision.toolCalls ?? []} toolMetrics={response?.metrics.toolMetrics ?? []} />}{assistant && <AgentAnswer message={assistant} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} />}</div></article>;
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

type JsonlRecord = { [key: string]: unknown; type?: string; id?: string; timestamp?: string; parentId?: string | null };

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function jsonText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((block) => {
    const item = jsonObject(block);
    if (!item) return '';
    if (typeof item.text === 'string') return item.text;
    if (typeof item.thinking === 'string') return item.thinking;
    if (typeof item.name === 'string') return item.name;
    return '';
  }).filter(Boolean).join('\n');
}

function jsonlUsage(record: JsonlRecord) {
  const message = jsonObject(record.message);
  const data = jsonObject(record.data);
  const response = jsonObject(data?.response);
  const metrics = jsonObject(response?.metrics);
  const usage = jsonObject(message?.usage ?? record.usage ?? metrics?.tokenUsage);
  if (!usage) return null;
  return {
    input: jsonNumber(usage.input),
    output: jsonNumber(usage.output),
    cacheRead: jsonNumber(usage.cacheRead),
    cacheWrite: jsonNumber(usage.cacheWrite),
    total: jsonNumber(usage.totalTokens ?? usage.total),
    cost: jsonNumber(jsonObject(usage.cost)?.total ?? usage.cost),
  };
}

type JsonlUsageSummary = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };

function parseJsonl(content: string): { entries: JsonlRecord[]; invalidLines: number } {
  const entries: JsonlRecord[] = [];
  let invalidLines = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      const entry = jsonObject(value);
      if (entry) entries.push(entry as JsonlRecord);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { entries, invalidLines };
}

function jsonlTypeLabel(entry: JsonlRecord) {
  const labels: Record<string, string> = { session: '会话头', message: '消息', custom: '工作台指标', custom_message: '自定义消息', thinking_level_change: 'Thinking', model_change: '模型', compaction: '上下文压缩', branch_summary: '分支摘要', session_info: '会话信息', label: '标签' };
  return labels[entry.type ?? ''] ?? entry.type ?? '未知';
}

function jsonlEntryRole(entry: JsonlRecord) {
  const message = jsonObject(entry.message);
  if (typeof message?.role === 'string') return message.role;
  if (typeof entry.customType === 'string') return entry.customType;
  return '';
}

function jsonlEntryPreview(entry: JsonlRecord) {
  const message = jsonObject(entry.message);
  if (message) {
    const text = jsonText(message.content);
    if (text) return text.replace(/\s+/g, ' ').slice(0, 180);
    if (typeof message.toolName === 'string') return message.toolName;
    if (typeof message.model === 'string') return message.model;
  }
  if (entry.type === 'session') return `${String(entry.id ?? '')} · ${String(entry.cwd ?? '')}`;
  if (entry.type === 'model_change') return `${String(entry.provider ?? '')} / ${String(entry.modelId ?? '')}`;
  if (entry.type === 'compaction') return String(entry.summary ?? '').replace(/\s+/g, ' ').slice(0, 180);
  if (entry.type === 'branch_summary') return String(entry.summary ?? '').replace(/\s+/g, ' ').slice(0, 180);
  if (typeof entry.customType === 'string') {
    const data = jsonObject(entry.data);
    const response = jsonObject(data?.response);
    const metrics = jsonObject(response?.metrics);
    if (metrics) return `第 ${String(metrics.turn ?? '?')} 轮 · ${formatDuration(jsonNumber(metrics.durationMs))} · ${jsonNumber(metrics.eventCount)} 个事件`;
    return entry.customType;
  }
  return '';
}

function SessionJsonlViewer({ document }: { document: AgentResourceDocument }) {
  const parsed = useMemo(() => parseJsonl(document.content), [document.content]);
  const [filter, setFilter] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const query = filter.trim().toLocaleLowerCase();
  const visibleEntries = parsed.entries.filter((entry) => !query || `${entry.type ?? ''} ${jsonlEntryRole(entry)} ${jsonlEntryPreview(entry)} ${JSON.stringify(entry)}`.toLocaleLowerCase().includes(query));
  const header = parsed.entries.find((entry) => entry.type === 'session');
  const messageCount = parsed.entries.filter((entry) => entry.type === 'message').length;
  const toolCount = parsed.entries.filter((entry) => jsonObject(entry.message)?.role === 'toolResult').length;
  const usage = parsed.entries.reduce<JsonlUsageSummary>((total, entry) => {
    const item = jsonlUsage(entry);
    if (!item || entry.type === 'custom') return total;
    return { input: total.input + item.input, output: total.output + item.output, cacheRead: total.cacheRead + item.cacheRead, cacheWrite: total.cacheWrite + item.cacheWrite, total: total.total + item.total, cost: total.cost + item.cost };
  }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
  const latestTurn = [...parsed.entries].reverse().find((entry) => entry.type === 'custom' && entry.customType === 'pi-workbench.turn');
  const latestMetrics = jsonObject(jsonObject(latestTurn?.data)?.response) ? jsonObject(jsonObject(latestTurn?.data)?.response)?.metrics : undefined;
  const latestContext = jsonObject(latestMetrics)?.contextUsage;
  const latestContextRecord = jsonObject(latestContext);
  return <div className="session-jsonl-viewer">
    <section className="session-jsonl-summary" aria-label="Session 文件指标">
      <div><span>Entries</span><strong>{parsed.entries.length}</strong></div>
      <div><span>消息</span><strong>{messageCount}</strong></div>
      <div><span>工具结果</span><strong>{toolCount}</strong></div>
      <div><span>Total Token</span><strong>{usage.total.toLocaleString('zh-CN')}</strong></div>
      <div><span>缓存读取</span><strong>{usage.cacheRead.toLocaleString('zh-CN')}</strong></div>
      <div><span>成本</span><strong>{usage.cost ? usage.cost.toFixed(6) : '0'}</strong></div>
      {latestContextRecord ? <div><span>当前上下文</span><strong>{jsonNumber(latestContextRecord.tokens).toLocaleString('zh-CN')} / {jsonNumber(latestContextRecord.contextWindow).toLocaleString('zh-CN')}</strong></div> : null}
    </section>
    <div className="session-jsonl-toolbar">
      <label><MagnifyingGlass size={13} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="筛选 entry、工具或内容" aria-label="筛选 Session 文件" /></label>
      <span>{visibleEntries.length}/{parsed.entries.length}</span>
      <button type="button" className={showRaw ? 'session-jsonl-view-button active' : 'session-jsonl-view-button'} onClick={() => setShowRaw((value) => !value)}>{showRaw ? '结构化视图' : '原始 JSONL'}</button>
    </div>
    {showRaw ? <pre className="resource-viewer-raw session-jsonl-raw">{document.content}</pre> : <div className="session-jsonl-timeline">{visibleEntries.map((entry, index) => <details className="session-jsonl-entry" key={`${String(entry.id ?? entry.type)}-${index}`} open={Boolean(query) || index === 0}><summary><span className={`session-entry-badge session-entry-${entry.type ?? 'unknown'}`}>{jsonlTypeLabel(entry)}</span><strong>{jsonlEntryRole(entry) || jsonlEntryPreview(entry) || '未命名 entry'}</strong><small>{entry.timestamp ? formatMetricTime(entry.timestamp) : '—'}</small></summary><div className="session-jsonl-entry-body"><p>{jsonlEntryPreview(entry) || '该 entry 没有可摘要的文本内容。'}</p><div className="session-jsonl-entry-meta"><span>id <code>{String(entry.id ?? '—')}</code></span>{entry.parentId !== undefined && <span>parent <code>{String(entry.parentId ?? 'root')}</code></span>}{jsonlUsage(entry) && <span>Token <code>{jsonlUsage(entry)!.total.toLocaleString('zh-CN')}</code></span>}</div><pre>{JSON.stringify(entry, null, 2)}</pre></div></details>)}</div>}
    {parsed.invalidLines > 0 && <p className="session-jsonl-warning">有 {parsed.invalidLines} 行无法解析，已保留在原始 JSONL 视图中。</p>}
    {header && <p className="session-jsonl-footnote">Session {String(header.id ?? '—')} · cwd {String(header.cwd ?? '—')}</p>}
  </div>;
}

function ResourceViewer({ document, loading, error, onClose }: { document: AgentResourceDocument | null; loading: boolean; error: string; onClose: () => void }) {
  const isSession = document?.resource.kind === 'session';
  const isRawText = document?.resource.path.endsWith('.jsonl');
  return <section className="resource-viewer" aria-label="项目文件预览" aria-busy={loading}>
    <header className="resource-viewer-header">
      <button type="button" className="resource-viewer-close" onClick={onClose} aria-label="返回聊天" title="返回聊天"><CaretLeft size={16} /></button>
      <div className="resource-viewer-heading">
        <strong>{document?.resource.title ?? '项目文件'}</strong>
        <span>{document?.resource.path ?? '正在读取文件内容'}</span>
      </div>
      <span className="resource-viewer-kind">{document ? fileKindLabel(document.resource) : 'MD'}</span>
    </header>
    <div className="resource-viewer-scroll">
      {loading && <div className="resource-viewer-state" role="status"><strong>正在读取文件</strong><span>只读内容即将显示在这里。</span></div>}
      {!loading && error && <div className="resource-viewer-state resource-viewer-error" role="alert"><strong>文件读取失败</strong><span>{error}</span><button type="button" onClick={onClose}>返回聊天</button></div>}
      {!loading && !error && document && (isSession ? <SessionJsonlViewer document={document} /> : isRawText ? <pre className="resource-viewer-raw">{document.content}</pre> : <article className="resource-viewer-body markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{document.content}</Markdown></article>)}
    </div>
  </section>;
}

function SessionList({ sessions, currentSessionId, pending, onSelect, onNewSession }: { sessions: SessionRecord[]; currentSessionId: string; pending: boolean; onSelect: (id: string) => void; onNewSession: () => void }) {
  return <nav className="workspace-session-list" aria-label="会话列表"><button type="button" className="new-session-button session-new-session" onClick={onNewSession}><Plus size={14} weight="bold" />新建会话</button>{sessions.length ? <div className="session-rows">{sessions.map((session) => { const isCurrent = session.id === currentSessionId; const messageCount = session.messages.filter((message) => message.kind === 'user').length; return <button type="button" className={isCurrent ? 'session-row session-row-current' : 'session-row'} key={session.id} onClick={() => onSelect(session.id)} disabled={pending && !isCurrent} aria-current={isCurrent ? 'page' : undefined} title={sessionTitle(session.messages)}><span className="session-row-icon"><ChatCircle size={15} weight={isCurrent ? 'fill' : 'duotone'} /></span><span className="session-row-copy"><strong>{sessionTitle(session.messages)}</strong><small>{messageCount ? `${messageCount} 次提问` : '尚未提问'}</small></span>{isCurrent && <span className="session-row-state">当前</span>}</button>; })}</div> : <div className="session-empty"><ChatCircle size={17} /><strong>暂无会话</strong><span>开始对话后，会话会显示在这里。</span></div>}</nav>;
}

function WorkspacePanel({ workspace, sessions, currentSessionId, view, tree, filter, selectedResource, collapsedPaths, pending, refreshing, authUser, open, onToggleOpen, onViewChange, onFilterChange, onToggle, onSelect, onSelectSession, onNewSession, onRefreshWorkspace, onLogout }: { workspace: WorkspaceSnapshot; sessions: SessionRecord[]; currentSessionId: string; view: WorkspaceView; tree: FileTreeNode; filter: string; selectedResource: string; collapsedPaths: Set<string>; pending: boolean; refreshing: boolean; authUser?: AuthUser; open: boolean; onToggleOpen: () => void; onViewChange: (view: WorkspaceView) => void; onFilterChange: (value: string) => void; onToggle: (path: string) => void; onSelect: (path: string) => void; onSelectSession: (id: string) => void; onNewSession: () => void; onRefreshWorkspace: () => void; onLogout: () => void }) {
  const showingSessions = view === 'sessions';
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const hasMatchingResource = treeHasMatch(tree, normalizedFilter);
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextView = event.key === 'Home' || (event.key === 'ArrowLeft' && showingSessions) || (event.key === 'ArrowRight' && !showingSessions) ? 'sessions' : 'files';
    onViewChange(nextView);
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${nextView}`)?.focus());
  };
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
            <button type="button" id="workspace-tab-sessions" role="tab" className={showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('sessions')} onKeyDown={handleTabKeyDown} aria-controls="workspace-view-panel" aria-selected={showingSessions} tabIndex={showingSessions ? 0 : -1}>
              <ChatCircle size={14} weight={showingSessions ? 'fill' : 'regular'} />
              <span>会话</span>
              <small>{sessions.length}</small>
            </button>
            <button type="button" id="workspace-tab-files" role="tab" className={!showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('files')} onKeyDown={handleTabKeyDown} aria-controls="workspace-view-panel" aria-selected={!showingSessions} tabIndex={showingSessions ? -1 : 0}>
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
                  <button type="button" className={refreshing ? 'workspace-refresh-button is-refreshing' : 'workspace-refresh-button'} onClick={onRefreshWorkspace} disabled={refreshing} aria-busy={refreshing} aria-label={refreshing ? '正在刷新项目资源' : '刷新项目资源'} title={refreshing ? '正在刷新' : '刷新项目资源'}><ArrowsClockwise size={14} /></button>
                </div>
                <div className="workspace-tree" aria-label="Pi 项目文件树">
                  {hasMatchingResource ? <FileTree node={tree} depth={0} query={normalizedFilter} collapsedPaths={collapsedPaths} selectedResource={selectedResource} onToggle={onToggle} onSelect={onSelect} /> : <div className="workspace-empty-filter" role="status"><MagnifyingGlass size={17} /><strong>没有匹配的文件</strong><span>换个关键词试试，或清空筛选。</span></div>}
                </div>
              </>
            )}
          </div>
          {authUser && <footer className="workspace-account-footer" aria-label="当前登录账号">
            <span className="workspace-account-avatar" aria-hidden="true">{authUser.name.slice(0, 1)}</span>
            <span className="workspace-account-copy"><strong>{authUser.name}</strong><small>飞书账号 · 已登录</small></span>
            <button type="button" className="workspace-logout-button" onClick={onLogout} aria-label="退出飞书登录" title="退出飞书登录"><SignOut size={14} /></button>
          </footer>}
        </div>
      ) : null}
    </aside>
  );
}

function WorkbenchApp({ authUser, onLogout }: { authUser?: AuthUser; onLogout: () => void }) {
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
  const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false);
  const resourceRequestRef = useRef(0);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const followConversationRef = useRef(true);
  const fileTree = useMemo(() => buildFileTree(workspace.resources), [workspace.resources]);
  const sessions = sessionRecords;

  useEffect(() => {
    setCollapsedPaths(new Set(collectCollapsedFolders(fileTree)));
  }, [fileTree]);

  useEffect(() => {
    if (!followConversationRef.current) return;
    const node = conversationScrollRef.current;
    if (!node) return;
    const frame = window.requestAnimationFrame(() => node.scrollTo({ top: node.scrollHeight, behavior: 'auto' }));
    return () => window.cancelAnimationFrame(frame);
  }, [sessionId, messages, pending]);

  async function refreshWorkspace() {
    setWorkspaceRefreshing(true);
    try {
      const response = await fetch('/api/v1/agent/workspace', { cache: 'no-store' });
      if (!response.ok) throw new Error('workspace unavailable');
      setWorkspace(await response.json() as WorkspaceSnapshot);
    } catch {
      // Keep the last known workspace snapshot when the API is restarting.
    } finally {
      setWorkspaceRefreshing(false);
    }
  }

  useEffect(() => {
    void refreshWorkspace();
  }, []);

  useEffect(() => {
    let active = true;
    const loadSessions = async () => {
      try {
        let records = await fetchSessionRecords();
        if (!records.length) records = [await createSessionRecord()];
        if (!active) return;
        const initial = records[0]!;
        followConversationRef.current = true;
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
    followConversationRef.current = true;
    setSessionId(record.id);
    setMessages(record.messages);
    setError('');
    closeResourceViewer();
  }

  function selectSession(nextSessionId: string) {
    if (pending || nextSessionId === sessionId) return;
    const target = sessionRecords.find((session) => session.id === nextSessionId);
    if (!target) return;
    followConversationRef.current = true;
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
    followConversationRef.current = true;
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
          <div className="conversation-scroll" ref={conversationScrollRef} onScroll={(event) => {
            const node = event.currentTarget;
            followConversationRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
          }}>
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
      <WorkspacePanel workspace={workspace} sessions={sessions} currentSessionId={sessionId} view={workspaceView} tree={fileTree} filter={resourceFilter} selectedResource={selectedResource} collapsedPaths={collapsedPaths} pending={pending} refreshing={workspaceRefreshing} authUser={authUser} open={workspaceOpen} onToggleOpen={() => setWorkspaceOpen((openState) => !openState)} onViewChange={setWorkspaceView} onFilterChange={setResourceFilter} onToggle={togglePath} onSelect={openResource} onSelectSession={selectSession} onNewSession={resetSession} onRefreshWorkspace={() => { if (!workspaceRefreshing) void refreshWorkspace(); }} onLogout={onLogout} />
      {error && <div className="error-toast" role="alert"><WarningCircle size={17} weight="fill" /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={14} /></button></div>}
    </div>
  );
}

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState('');

  const loadAuthStatus = async () => {
    setAuthLoading(true);
    try {
      const status = await fetchAuthStatus();
      setAuthStatus(status);
    } catch {
      setAuthStatus({ provider: 'feishu', configured: false, authRequired: true, authenticated: false, message: '登录服务暂时无法连接，请确认 API 服务已启动。' });
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('auth_error');
    if (error) {
      setAuthError(error);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    void loadAuthStatus();
  }, []);

  if (authLoading || !authStatus) return <AuthLoadingScreen />;
  if (authStatus.authRequired && !authStatus.authenticated) return <FeishuLoginPage status={authStatus} error={authError} onRetry={() => { setAuthError(''); void loadAuthStatus(); }} />;
  return <WorkbenchApp authUser={authStatus.user} onLogout={async () => {
    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthStatus((current) => current ? { ...current, authenticated: false, user: undefined } : current);
  }} />;
}

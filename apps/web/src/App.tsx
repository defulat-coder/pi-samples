import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { AgentEventSummary, AgentFeedback, AgentResourceDocument, AgentResourceSummary, AgentThinkingLevel, AuthStatusResponse, AuthUser, DigitalHumanChatResponse, DigitalHumanChatStreamEvent, DigitalHumanDefinition, DigitalHumanId, DigitalHumanSessionListResponse, DigitalHumanSessionMessage, DigitalHumanSessionRecord, PiRuntimeResourceSnapshot } from '@pi-workbench/contracts';
import { AnimatePresence, MotionConfig, motion, type Variants } from 'motion/react';
import { ArrowRight } from '@phosphor-icons/react/dist/icons/ArrowRight';
import { ArrowUpRight } from '@phosphor-icons/react/dist/icons/ArrowUpRight';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/icons/ArrowsClockwise';
import { Buildings } from '@phosphor-icons/react/dist/icons/Buildings';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { CaretLeft } from '@phosphor-icons/react/dist/icons/CaretLeft';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { ChatCircle } from '@phosphor-icons/react/dist/icons/ChatCircle';
import { Copy } from '@phosphor-icons/react/dist/icons/Copy';
import { Folder } from '@phosphor-icons/react/dist/icons/Folder';
import { FolderOpen } from '@phosphor-icons/react/dist/icons/FolderOpen';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PencilSimple } from '@phosphor-icons/react/dist/icons/PencilSimple';
import { Plus } from '@phosphor-icons/react/dist/icons/Plus';
import { ShieldCheck } from '@phosphor-icons/react/dist/icons/ShieldCheck';
import { SidebarSimple } from '@phosphor-icons/react/dist/icons/SidebarSimple';
import { SignOut } from '@phosphor-icons/react/dist/icons/SignOut';
import { ThumbsDown } from '@phosphor-icons/react/dist/icons/ThumbsDown';
import { ThumbsUp } from '@phosphor-icons/react/dist/icons/ThumbsUp';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { X } from '@phosphor-icons/react/dist/icons/X';
import { ChartBar } from '@phosphor-icons/react/dist/icons/ChartBar';
import { Cpu } from '@phosphor-icons/react/dist/icons/Cpu';
import { FileText } from '@phosphor-icons/react/dist/icons/FileText';
import { Info } from '@phosphor-icons/react/dist/icons/Info';
import { LockKey } from '@phosphor-icons/react/dist/icons/LockKey';
import { SlidersHorizontal } from '@phosphor-icons/react/dist/icons/SlidersHorizontal';
import { Sparkle } from '@phosphor-icons/react/dist/icons/Sparkle';
import { UserCircle } from '@phosphor-icons/react/dist/icons/UserCircle';
import { Wrench } from '@phosphor-icons/react/dist/icons/Wrench';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { applyAgentStreamEvent, buildToolActivities, createLiveTurnProcess, isVisibleProcessEvent, type ToolActivity } from './stream-process.js';

const BusinessPresentationView = lazy(() => import('./business-presentation.js').then((module) => ({ default: module.BusinessPresentationView })));

type UserMessageItem = Extract<DigitalHumanSessionMessage, { kind: 'user' }>;
type ThinkingMessageItem = Extract<DigitalHumanSessionMessage, { kind: 'thinking' }>;
type AssistantMessageItem = Extract<DigitalHumanSessionMessage, { kind: 'assistant' }> & { streamEvents?: AgentEventSummary[]; digitalHumanId?: DigitalHumanId };

/** The stream's semantic output stays split into sibling UI items. */
type ConversationItem = DigitalHumanSessionMessage;

type WorkspaceSnapshot = {
  digitalHumans: DigitalHumanDefinition[];
  resources: AgentResourceSummary[];
  tools: { enabled: string[]; policy: 'read-only' };
  model: { enabled: boolean; providerConfigured: boolean; provider?: string; model?: string; thinkingLevel?: string; available?: Array<{ id: string; name: string }> };
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

type SessionRecord = DigitalHumanSessionRecord;

type WorkspaceView = 'sessions' | 'files';

const emptyWorkspace: WorkspaceSnapshot = {
  digitalHumans: [],
  resources: [],
  tools: { enabled: [], policy: 'read-only' },
  model: { enabled: false, providerConfigured: false, thinkingLevel: 'off' },
};

const enabledThinkingLevel: AgentThinkingLevel = 'minimal';
/** Shared UI curve — mirrors `--ease-out` in styles.css. */
const motionEase = [0.23, 1, 0.32, 1] as const;

/** Welcome screen choreography — variants + staggerChildren, no hand-written delay chains. */
const welcomeGroup: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.05 } } };
const welcomeItem: Variants = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.18, ease: motionEase } } };

function newSessionId() {
  return `session_${Math.random().toString(36).slice(2, 10)}`;
}

function emptySessionRecord(digitalHumanId: DigitalHumanId, position = 0): SessionRecord {
  const now = new Date().toISOString();
  return { id: newSessionId(), digitalHumanId, position, createdAt: now, updatedAt: now, messages: [] };
}

function sortSessionRecords(records: SessionRecord[]) {
  return [...records].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.createdAt.localeCompare(left.createdAt));
}

function sessionTitle(session: Pick<SessionRecord, 'title' | 'messages'>) {
  if (session.title?.trim()) return session.title.trim();
  const firstUserMessage = session.messages.find((message): message is UserMessageItem => message.kind === 'user')?.text.trim();
  return firstUserMessage ? firstUserMessage.slice(0, 34) : '新对话';
}

function conversationTime(value?: string) {
  if (!value) return '刚刚';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '刚刚';
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return new Intl.DateTimeFormat('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function routeLabel(route: DigitalHumanChatResponse['route']) {
  return route === 'business-analytics' ? '经营分析' : '项目知识';
}

function responseSourceLabel(_source: DigitalHumanChatResponse['source']) {
  return 'Pi 会话';
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

function markdownBody(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function parseStreamPayload(eventName: string, data: string): DigitalHumanChatStreamEvent {
  const payload = JSON.parse(data) as Record<string, unknown>;
  if (eventName === 'start') return { type: 'start', digitalHumanId: String(payload.digitalHumanId), sessionId: String(payload.sessionId), model: payload.model as DigitalHumanChatResponse['model'] };
  if (eventName === 'event') return { type: 'event', event: payload.event as AgentEventSummary };
  if (eventName === 'text_delta') return { type: 'text_delta', delta: String(payload.delta ?? '') };
  if (eventName === 'thinking_delta') return { type: 'thinking_delta', delta: String(payload.delta ?? '') };
  if (eventName === 'done') return { type: 'done', response: payload.response as DigitalHumanChatResponse };
  if (eventName === 'error') return { type: 'error', message: String(payload.message ?? '数字人流式响应失败') };
  throw new Error(`未知的流式事件：${eventName}`);
}

async function consumeAgentStream(response: Response, onEvent: (event: DigitalHumanChatStreamEvent) => void): Promise<DigitalHumanChatResponse> {
  if (!response.body) throw new Error('数字人网关没有返回可读流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: DigitalHumanChatResponse | undefined;

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
  if (!finalResponse) throw new Error('数字人响应流在完成事件前结束');
  return finalResponse;
}

async function fetchSessionRecords(digitalHumanId: DigitalHumanId): Promise<SessionRecord[]> {
  const response = await fetch(`/api/v1/digital-humans/sessions?digitalHumanId=${encodeURIComponent(digitalHumanId)}`);
  if (!response.ok) throw new Error('会话列表暂时无法读取');
  const payload = await response.json() as DigitalHumanSessionListResponse;
  return sortSessionRecords(payload.items);
}

async function fetchSessionRecord(id: string, digitalHumanId: DigitalHumanId): Promise<SessionRecord> {
  const response = await fetch(`/api/v1/digital-humans/sessions/${encodeURIComponent(id)}?digitalHumanId=${encodeURIComponent(digitalHumanId)}`);
  if (!response.ok) throw new Error('会话内容暂时无法读取');
  return response.json() as Promise<SessionRecord>;
}

async function renameSessionRecord(id: string, digitalHumanId: DigitalHumanId, title: string): Promise<SessionRecord> {
  const response = await fetch(`/api/v1/digital-humans/sessions/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ digitalHumanId, title }) });
  if (!response.ok) throw new Error('会话名称暂时无法保存');
  return response.json() as Promise<SessionRecord>;
}

async function deleteSessionRecord(id: string, digitalHumanId: DigitalHumanId): Promise<void> {
  const response = await fetch(`/api/v1/digital-humans/sessions/${encodeURIComponent(id)}?digitalHumanId=${encodeURIComponent(digitalHumanId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) throw new Error('会话暂时无法删除');
}

async function fetchAuthStatus(): Promise<AuthStatusResponse> {
  const response = await fetch('/api/v1/auth/status', { credentials: 'include', cache: 'no-store' });
  if (!response.ok) throw new Error('登录服务暂时无法连接');
  return response.json() as Promise<AuthStatusResponse>;
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const helper = document.createElement('textarea');
  helper.value = text;
  helper.style.position = 'fixed';
  helper.style.opacity = '0';
  document.body.appendChild(helper);
  helper.select();
  document.execCommand('copy');
  helper.remove();
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
      <header className="auth-brand"><span className="auth-brand-mark">π</span><span><strong>Pi 工作台</strong><small>本地数字人工作区</small></span></header>
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
  if (resource?.kind === 'digital-human') return 'HUMAN';
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
    return <button type="button" role="treeitem" aria-level={depth + 1} className={isSelected ? 'tree-row tree-file selected' : 'tree-row tree-file'} style={indentStyle} onClick={() => onSelect(node.path)} title={node.path}><span className="tree-file-copy"><strong>{node.name}</strong><small>{resourceTitle(node.resource.title)}</small></span></button>;
  }

  const isOpen = Boolean(query) || !collapsedPaths.has(node.path);
  return <div className="tree-node"><button type="button" role="treeitem" aria-level={depth + 1} className="tree-row tree-folder" style={indentStyle} onClick={() => onToggle(node.path)} aria-expanded={isOpen}><span className="tree-folder-icon">{isOpen ? <FolderOpen size={16} weight="duotone" /> : <Folder size={16} weight="duotone" />}</span><span className="tree-file-copy"><strong>{node.name}</strong><small className="tree-folder-count" aria-label={`${node.fileCount} 个文件`}>{node.fileCount}</small></span>{isOpen ? <CaretDown size={13} /> : <CaretRight size={13} />}</button>{isOpen && <div className="tree-children" role="group">{node.children.map((child) => <FileTree key={child.path} node={child} depth={depth + 1} query={query} collapsedPaths={collapsedPaths} selectedResource={selectedResource} onToggle={onToggle} onSelect={onSelect} />)}</div>}</div>;
});

function SourceList({ response, onOpenResource }: { response: DigitalHumanChatResponse; onOpenResource: (path: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!response.sources.length) return null;
  if (!expanded) {
    return <button type="button" className="source-toggle" onClick={() => setExpanded(true)} aria-expanded="false" aria-label={`展开 ${response.sources.length} 个来源`}>{response.sources.length} 个来源<CaretRight size={12} aria-hidden="true" /></button>;
  }
  return <div className="source-list">{response.sources.map((source) => {
    const canOpen = source.kind === 'knowledge' && source.ref.startsWith('.pi/');
    const content = <><span className="source-kind">{source.kind === 'database' ? 'DB' : 'MD'}</span><span><strong>{resourceTitle(source.title)}</strong><small>{source.ref}</small></span>{canOpen && <CaretRight size={13} aria-hidden="true" />}</>;
    return canOpen ? <button type="button" className="source-row source-row-action" key={source.ref} onClick={() => onOpenResource(source.ref.split('#')[0]!)} aria-label={`打开来源：${resourceTitle(source.title)}`}>{content}</button> : <div className="source-row" key={source.ref}>{content}</div>;
  })}</div>;
}

function ThinkingBlock({ message }: { message: ThinkingMessageItem }) {
  const [open, setOpen] = useState(false);
  if (!message.text) return null;
  const isWorking = message.status === 'streaming';
  return <section className="agent-turn-thinking" aria-label="思考过程" aria-busy={isWorking} aria-live={isWorking ? 'polite' : undefined}><details className="thinking-trace" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className="thinking-trace-title"><i className={isWorking ? 'thinking-trace-dot thinking-trace-dot-active' : 'thinking-trace-dot'} aria-hidden="true" />{isWorking ? '正在思考…' : '已思考'}</span><small>{isWorking ? '' : `${message.text.length} 字符`}<CaretRight size={12} aria-hidden="true" /></small></summary><pre>{message.text}</pre></details></section>;
}

function toolActivityTitle(toolName: string) {
  const labels: Record<string, string> = { search_knowledge: '搜索项目知识', read: '读取文件', query_business_data: '查询业务数据' };
  return labels[toolName] ?? `使用 ${toolName}`;
}

function toolActivityDescription(activity: ToolActivity) {
  if (!activity.input) return '';
  try {
    const value = JSON.parse(activity.input) as Record<string, unknown>;
    const description = value.query ?? value.path ?? value.file_path ?? value.prompt;
    if (typeof description === 'string') return description;
  } catch {
    // Keep non-JSON tool input available only in the expanded details.
  }
  return '';
}

function ToolActivityBlock({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const description = toolActivityDescription(activity);
  const statusLabel = activity.status === 'running' ? '运行中' : activity.status === 'error' ? '失败' : '完成';
  return <details className={`tool-activity tool-activity-${activity.status}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className="tool-activity-status" aria-hidden="true">{activity.status === 'completed' ? <Check size={13} weight="bold" /> : activity.status === 'error' ? <WarningCircle size={13} weight="fill" /> : <i />}</span><span className="tool-activity-copy"><strong>{toolActivityTitle(activity.toolName)}</strong>{description && <small>{description}</small>}</span><span className="tool-activity-meta">{statusLabel}{activity.durationMs !== undefined ? ` · ${formatDuration(activity.durationMs)}` : ''}</span><CaretRight className="tool-activity-caret" size={13} aria-hidden="true" /></summary><div className="tool-activity-details">{activity.input && <div><span>输入</span><pre>{activity.input}</pre></div>}{activity.output && <div><span>结果</span><pre>{activity.output}</pre></div>}</div></details>;
}

function ToolActivityList({ events, isWorking }: { events: AgentEventSummary[]; isWorking: boolean }) {
  const activities = useMemo(() => buildToolActivities(events), [events]);
  if (!activities.length) return null;
  return <section className="tool-activity-list" aria-label="工具调用" aria-live={isWorking ? 'polite' : undefined}>{activities.map((activity) => <ToolActivityBlock activity={activity} key={activity.id} />)}</section>;
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

function AgentMetrics({ response }: { response: DigitalHumanChatResponse }) {
  const metrics = response.metrics;
  if (!metrics) return null;
  const tokens = metrics.tokenUsage;
  const tokenLabel = tokens.source === 'estimated' ? `${tokens.total.toLocaleString('zh-CN')}（估算）` : tokens.source === 'provider' ? tokens.total.toLocaleString('zh-CN') : '未提供';
  const contextLabel = metrics.contextUsage?.tokens === null || metrics.contextUsage?.tokens === undefined ? '未知' : `${metrics.contextUsage.tokens.toLocaleString('zh-CN')} / ${metrics.contextUsage.contextWindow.toLocaleString('zh-CN')}`;
  const sessionTotals = metrics.sessionTotals;
  return <section className="agent-metrics" aria-label="执行指标">
      <div className="agent-metrics-grid">
        <span>执行轮次<strong>{metrics.executionRounds}</strong></span>
        <span>耗时<strong>{formatDuration(metrics.durationMs)}</strong></span>
        <span>工具<strong>{metrics.toolCallCount}/{metrics.toolResultCount}</strong></span>
        <span>上下文<strong>{contextLabel}</strong></span>
        <span>开始时间<strong>{formatMetricTime(metrics.startedAt)}</strong></span>
        <span>完成时间<strong>{formatMetricTime(metrics.completedAt)}</strong></span>
        <span>输入字符<strong>{metrics.inputChars.toLocaleString('zh-CN')}</strong></span>
        <span>输出字符<strong>{metrics.outputChars.toLocaleString('zh-CN')}</strong></span>
        <span>Thinking 字符<strong>{metrics.thinkingChars.toLocaleString('zh-CN')}</strong></span>
        <span>模型<strong>{response.model.model ?? '未配置'}</strong></span>
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
  </section>;
}

function AgentRunDetails({ response }: { response: DigitalHumanChatResponse }) {
  const metrics = response.metrics;
  return <details className="agent-run-details"><summary><span>运行指标</span><small>{formatDuration(metrics.durationMs)} · {metrics.toolCallCount} 个工具 · {metrics.eventCount} 个原始事件</small><CaretDown size={13} aria-hidden="true" /></summary><div className="agent-run-details-body"><AgentMetrics response={response} /></div></details>;
}

function AgentActions({ message, copiedMessageId, feedbackPending, onCopy, onFeedback }: { message: AssistantMessageItem; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void }) {
  const feedback = message.feedback ?? null;
  const feedbackReady = Boolean(message.response && message.persisted);
  return <div className="agent-actions" aria-label="回答操作">
    <button type="button" className="agent-action-button" onClick={() => onCopy(message.id, message.text)} disabled={!message.text} aria-label={copiedMessageId === message.id ? '已复制回答' : '复制回答'} title={copiedMessageId === message.id ? '已复制' : '复制'}>{copiedMessageId === message.id ? <Check size={14} weight="bold" /> : <Copy size={14} />}</button>
    <span className="agent-actions-divider" aria-hidden="true" />
    <button type="button" className={feedback === 'like' ? 'agent-action-button agent-action-button-active' : 'agent-action-button'} onClick={() => onFeedback(message.id, feedback === 'like' ? null : 'like')} disabled={!feedbackReady || feedbackPending === message.id} aria-pressed={feedback === 'like'} aria-label="点赞" title="点赞"><ThumbsUp size={14} weight={feedback === 'like' ? 'fill' : 'regular'} /></button>
    <button type="button" className={feedback === 'dislike' ? 'agent-action-button agent-action-button-active' : 'agent-action-button'} onClick={() => onFeedback(message.id, feedback === 'dislike' ? null : 'dislike')} disabled={!feedbackReady || feedbackPending === message.id} aria-pressed={feedback === 'dislike'} aria-label="点踩" title="点踩"><ThumbsDown size={14} weight={feedback === 'dislike' ? 'fill' : 'regular'} /></button>
  </div>;
}

function AgentAnswer({ message, copiedMessageId, feedbackPending, onCopy, onFeedback, onOpenResource }: { message: AssistantMessageItem; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void; onOpenResource: (path: string) => void }) {
  const isWorking = !message.response;
  return <section className="agent-turn-answer" aria-live={isWorking ? 'polite' : undefined} aria-busy={isWorking}>{message.response?.analysis ? <Suspense fallback={<div className="business-presentation-loading">正在准备数据视图…</div>}><BusinessPresentationView analysis={message.response.analysis} /></Suspense> : null}{message.text ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div> : isWorking ? <div className="typing-line" aria-label="正在生成回答"><i /><i /><i /></div> : null}{message.response ? <div className="message-evidence"><div className="evidence-head"><span className="response-tag response-tag-live">{responseSourceLabel(message.response.source)}</span><span className="route-tag">路径 · {routeLabel(message.response.route)}</span><span className="evidence-runtime">{formatDuration(message.response.metrics.durationMs)} · {message.response.metrics.toolCallCount} 个工具</span></div><SourceList response={message.response} onOpenResource={onOpenResource} /></div> : null}{message.text || message.response ? <AgentActions message={message} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} /> : null}{message.response ? <AgentRunDetails response={message.response} /> : null}</section>;
}

type AgentTurnMessages = { turnId: string; thinking?: ThinkingMessageItem; assistant?: AssistantMessageItem };

function AgentTurn({ digitalHuman, thinking, assistant, copiedMessageId, feedbackPending, onCopy, onFeedback, onOpenResource }: { digitalHuman: DigitalHumanDefinition; thinking?: ThinkingMessageItem; assistant?: AssistantMessageItem; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void; onOpenResource: (path: string) => void }) {
  const response = assistant?.response;
  const isWorking = !response;
  const events = response?.events.length ? response.events.filter(isVisibleProcessEvent) : assistant?.streamEvents ?? [];
  return <article className="agent-turn" aria-label={`${digitalHuman.displayName}回合`}><div className={`agent-turn-avatar message-avatar digital-human-accent-${digitalHuman.avatar.accent}`}><span className="agent-avatar-mark">{digitalHuman.avatar.initials}</span></div><div className="agent-turn-content"><div className="message-meta"><strong>{digitalHuman.displayName} · {digitalHuman.role}</strong><span>{isWorking ? '处理中' : conversationTime(assistant?.createdAt ?? response?.createdAt)}</span></div>{thinking ? <ThinkingBlock message={thinking} /> : null}{events.length > 0 ? <ToolActivityList events={events} isWorking={isWorking} /> : null}{assistant ? <AgentAnswer message={assistant} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} onOpenResource={onOpenResource} /> : null}</div></article>;
}

function UserMessage({ message }: { message: UserMessageItem }) {
  return <article className="message message-user"><div className="message-body"><div className="message-meta"><strong>你</strong><span>{conversationTime(message.createdAt)}</span></div><p>{message.text}</p></div></article>;
}

function ConversationStream({ digitalHuman, messages, copiedMessageId, feedbackPending, onCopy, onFeedback, onOpenResource }: { digitalHuman: DigitalHumanDefinition; messages: ConversationItem[]; copiedMessageId: string; feedbackPending: string; onCopy: (messageId: string, text: string) => void; onFeedback: (messageId: string, feedback: AgentFeedback | null) => void; onOpenResource: (path: string) => void }) {
  // Only animate turns that arrive after the first committed render; history loads must not replay.
  const committedKeysRef = useRef<Set<string>>(new Set());
  const nodes: ReactNode[] = [];
  const nodeKeys: string[] = [];
  const wrapNode = (key: string, child: ReactNode) => {
    nodeKeys.push(key);
    const isNew = !committedKeysRef.current.has(key);
    nodes.push(<motion.div key={key} initial={isNew ? { opacity: 0, y: 4 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: motionEase }}>{child}</motion.div>);
  };
  let turn: AgentTurnMessages | null = null;
  const flushTurn = () => {
    if (!turn) return;
    wrapNode(`agent-turn-${turn.turnId}`, <AgentTurn digitalHuman={digitalHuman} thinking={turn.thinking} assistant={turn.assistant} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={onCopy} onFeedback={onFeedback} onOpenResource={onOpenResource} />);
    turn = null;
  };
  for (const message of messages) {
    if (message.kind === 'user') {
      flushTurn();
      wrapNode(message.id, <UserMessage message={message} />);
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
  useEffect(() => {
    for (const key of nodeKeys) committedKeysRef.current.add(key);
  });
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
      <div><span>成本（USD）</span><strong>{usage.cost ? usage.cost.toFixed(6) : '0'}</strong></div>
      {latestContextRecord ? <div className="session-jsonl-summary-context"><span>当前上下文</span><strong>{jsonNumber(latestContextRecord.tokens).toLocaleString('zh-CN')} / {jsonNumber(latestContextRecord.contextWindow).toLocaleString('zh-CN')}</strong></div> : null}
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
  const isJson = document?.resource.path.endsWith('.json');
  const isRawText = document?.resource.path.endsWith('.jsonl') || isJson;
  const [copiedPath, setCopiedPath] = useState(false);
  let displayContent = document?.content ?? '';
  if (isJson) {
    try {
      displayContent = JSON.stringify(JSON.parse(displayContent), null, 2);
    } catch {
      // Preserve malformed JSON verbatim so the user can inspect the source.
    }
  }
  return <motion.section className="resource-viewer" aria-label="项目文件预览" aria-busy={loading} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.18, ease: motionEase } }} exit={{ opacity: 0, x: -4, transition: { duration: 0.08, ease: motionEase } }}>
    <header className="resource-viewer-header">
      <button type="button" className="resource-viewer-close" onClick={onClose} aria-label="返回聊天" title="返回聊天"><CaretLeft size={16} /></button>
      <div className="resource-viewer-heading">
        <strong>{document?.resource.title ?? '项目文件'}</strong>
        <span>{document?.resource.path ?? '正在读取文件内容'}</span>
      </div>
      {document && <button type="button" className="resource-viewer-copy" onClick={() => { void copyText(document.resource.path).then(() => { setCopiedPath(true); window.setTimeout(() => setCopiedPath(false), 1600); }).catch(() => setCopiedPath(false)); }} aria-label={copiedPath ? '已复制文件路径' : '复制文件路径'} title={copiedPath ? '已复制' : '复制路径'}>{copiedPath ? <Check size={14} weight="bold" /> : <Copy size={14} />}</button>}
      <span className="resource-viewer-kind">{document ? fileKindLabel(document.resource) : 'MD'}</span>
    </header>
    <div className="resource-viewer-scroll">
      {loading && <div className="resource-viewer-state" role="status"><strong>正在读取文件</strong><span>只读内容即将显示在这里。</span></div>}
      {!loading && error && <div className="resource-viewer-state resource-viewer-error" role="alert"><strong>文件读取失败</strong><span>{error}</span><button type="button" onClick={onClose}>返回聊天</button></div>}
      {!loading && !error && document && (isSession ? <SessionJsonlViewer document={document} /> : isRawText ? <pre className="resource-viewer-raw">{displayContent}</pre> : <article className="resource-viewer-body markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{markdownBody(document.content)}</Markdown></article>)}
    </div>
  </motion.section>;
}

function SessionList({ sessions, currentSessionId, pending, onSelect, onRename, onDelete }: { sessions: SessionRecord[]; currentSessionId: string; pending: boolean; onSelect: (id: string) => void; onRename: (id: string, title: string) => Promise<void>; onDelete: (id: string) => Promise<void> }) {
  const [editingId, setEditingId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [savingId, setSavingId] = useState('');

  const saveTitle = async (session: SessionRecord) => {
    const title = draftTitle.trim();
    if (!title) return;
    setSavingId(session.id);
    try {
      await onRename(session.id, title);
      setEditingId('');
    } finally {
      setSavingId('');
    }
  };

  return <nav className="workspace-session-list" aria-label="会话列表">
    {sessions.length ? <div className="session-rows"><AnimatePresence initial={false} mode="popLayout">{sessions.map((session) => {
      const isCurrent = session.id === currentSessionId;
      const title = sessionTitle(session);
      const messageCount = session.messages.filter((message) => message.kind === 'user').length;
      return <motion.div key={session.id} layout="position" layoutDependency={sessions} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.16, ease: motionEase, layout: { duration: 0.18, ease: motionEase } }}>
        {editingId === session.id ? <form className="session-rename" onSubmit={(event) => { event.preventDefault(); void saveTitle(session); }}><input autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setEditingId(''); }} aria-label="会话名称" maxLength={80} /><button type="submit" disabled={!draftTitle.trim() || savingId === session.id} aria-label="保存会话名称"><Check size={14} /></button><button type="button" onClick={() => setEditingId('')} aria-label="取消重命名"><X size={14} /></button></form> : <div className={isCurrent ? 'session-row-shell session-row-current' : 'session-row-shell'}>
          <button type="button" className="session-row" onClick={() => onSelect(session.id)} disabled={pending && !isCurrent} aria-current={isCurrent ? 'page' : undefined} title={title}><span className="session-row-icon"><ChatCircle size={15} weight={isCurrent ? 'fill' : 'duotone'} /></span><span className="session-row-copy"><strong>{title}</strong><small>{messageCount ? `${messageCount} 次提问` : '尚未提问'} · {conversationTime(session.updatedAt)}</small></span>{isCurrent && <span className="session-row-state">当前</span>}</button>
          <div className="session-row-actions"><button type="button" onClick={() => { setEditingId(session.id); setDraftTitle(title); }} aria-label={`重命名${title}`} title="重命名"><PencilSimple size={13} /></button><button type="button" onClick={() => { if (window.confirm(`删除会话“${title}”？此操作无法撤销。`)) void onDelete(session.id); }} aria-label={`删除${title}`} title="删除"><Trash size={13} /></button></div>
        </div>}
      </motion.div>;
    })}</AnimatePresence></div> : <div className="session-empty"><ChatCircle size={17} /><strong>暂无会话</strong><span>开始对话后，会话会显示在这里。</span></div>}
  </nav>;
}

function flattenResources(node: FileTreeNode, acc: AgentResourceSummary[] = []): AgentResourceSummary[] {
  if (node.resource) acc.push(node.resource);
  for (const child of node.children) flattenResources(child, acc);
  return acc;
}

/** LangSmith-style agent configure panel: the digital human's host-injected profile, shown as collapsible sections. */
const digitalHumanToolCatalog: Record<string, { title: string; description: string; icon: ReactNode }> = {
  read: { title: '读取文件', description: '读取工作区内的项目文件内容', icon: <FileText size={16} /> },
  search_knowledge: { title: '检索知识库', description: '在项目 Markdown 知识库中检索相关条目', icon: <MagnifyingGlass size={16} /> },
  query_business_data: { title: '业务数据查询', description: '基于语义模型查询认证业务指标', icon: <ChartBar size={16} /> },
};

function ConfigSection({ icon, title, defaultOpen = false, children }: { icon: ReactNode; title: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="config-section">
      <button type="button" className="config-section-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {icon}<strong>{title}</strong>
        <motion.span className="config-section-chevron" animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.16, ease: motionEase }}><CaretDown size={13} weight="bold" /></motion.span>
      </button>
      <AnimatePresence initial={false}>{open ? (
        <motion.div className="config-section-body" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0, transition: { duration: 0.14, ease: motionEase } }} transition={{ duration: 0.22, ease: motionEase }}>
          <div className="config-card">{children}</div>
        </motion.div>
      ) : null}</AnimatePresence>
    </section>
  );
}

function DigitalHumanConfigPanel({ digitalHuman, model, onClose }: { digitalHuman: DigitalHumanDefinition; model: WorkspaceSnapshot['model']; onClose: () => void }) {
  return (
    <motion.aside className="config-panel" aria-label={`${digitalHuman.displayName} 配置`} initial={{ x: 24, opacity: 0 }} animate={{ x: 0, opacity: 1, transition: { duration: 0.22, ease: motionEase } }} exit={{ x: 24, opacity: 0, transition: { duration: 0.12, ease: motionEase } }}>
      <div className="config-agent-card">
        <span className={`config-agent-avatar digital-human-accent-${digitalHuman.avatar.accent}`} aria-hidden="true">{digitalHuman.avatar.initials}</span>
        <div className="config-agent-meta"><strong>{digitalHuman.displayName}</strong><span>{digitalHuman.tagline}</span></div>
        <button type="button" className="config-panel-close" onClick={onClose} aria-label="关闭配置面板"><X size={15} /></button>
      </div>
      <div className="config-panel-scroll">
        <ConfigSection icon={<Wrench size={15} />} title="能力工具" defaultOpen>
          <p className="config-card-desc">由宿主按需注入的工具，全部为只读能力，不会修改项目文件。</p>
          {digitalHuman.tools.map((tool) => {
            const meta = digitalHumanToolCatalog[tool];
            return (
              <div className="config-row" key={tool}>
                <span className="config-row-icon" aria-hidden="true">{meta?.icon ?? <Wrench size={16} />}</span>
                <div className="config-row-meta">
                  <strong>{meta?.title ?? tool}<span className="config-row-badge"><LockKey size={9} weight="bold" />只读</span></strong>
                  <span>{meta?.description ?? tool}</span>
                </div>
              </div>
            );
          })}
        </ConfigSection>
        <ConfigSection icon={<UserCircle size={15} />} title="角色档案">
          <p className="config-card-desc">{digitalHuman.persona.mission}</p>
          <div className="config-chips">{digitalHuman.persona.traits.map((trait) => <span className="config-chip" key={trait}>{trait}</span>)}</div>
          <p className="config-card-desc">{digitalHuman.persona.communicationStyle}</p>
        </ConfigSection>
        <ConfigSection icon={<Sparkle size={15} />} title="技能">
          {digitalHuman.skills.map((skill) => (
            <div className="config-row" key={skill}>
              <span className="config-row-icon" aria-hidden="true"><Sparkle size={15} /></span>
              <div className="config-row-meta"><strong>{skill}</strong></div>
            </div>
          ))}
        </ConfigSection>
        <ConfigSection icon={<Cpu size={15} />} title="运行时">
          <div className="config-kv"><span>模型</span><strong>{model.model ?? '未配置'}</strong></div>
          <div className="config-kv"><span>思考级别</span><strong>{model.thinkingLevel ?? 'off'}</strong></div>
          <div className="config-kv"><span>能力档案</span><strong>{digitalHuman.capabilityLabel}</strong></div>
        </ConfigSection>
      </div>
    </motion.aside>
  );
}

/** LangSmith-style model picker in the composer toolbar: switches among the configured provider's catalog. */
function ModelPicker({ models, current, disabled, onSelect }: { models: Array<{ id: string; name: string }>; current: string; disabled: boolean; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  const active = models.find((model) => model.id === current);
  return <div className="model-picker" ref={rootRef}>
    <button type="button" className="composer-tool-button model-picker-trigger" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((value) => !value)} title={active ? `${active.name}（${active.id}）` : current}>
      <Cpu size={13} /><span className="model-picker-label">{current || '未配置'}</span><CaretDown size={11} aria-hidden="true" />
    </button>
    <AnimatePresence>{open ? <motion.div className="model-picker-panel" role="dialog" aria-label="选择模型" initial={{ opacity: 0, scale: 0.97, y: 2 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.98, y: 2, transition: { duration: 0.1, ease: motionEase } }} transition={{ duration: 0.16, ease: motionEase }} style={{ transformOrigin: 'bottom left' }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
      <div className="model-picker-options" role="listbox" aria-label="可用模型">
        {models.map((model) => {
          const selected = model.id === current;
          return <button type="button" role="option" aria-selected={selected} key={model.id} className={selected ? 'model-picker-option model-picker-option-active' : 'model-picker-option'} onClick={() => { setOpen(false); onSelect(model.id); }}>
            <span className="model-picker-option-copy"><strong>{model.name}</strong><small>{model.id}</small></span>
            {selected ? <Check size={13} weight="bold" aria-hidden="true" /> : null}
          </button>;
        })}
      </div>
    </motion.div> : null}</AnimatePresence>
  </div>;
}

type PaletteItem = { id: string; group: string; label: string; hint?: string; icon?: ReactNode; run: () => void };
type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  digitalHumans: DigitalHumanDefinition[];
  sessions: SessionRecord[];
  resources: AgentResourceSummary[];
  actions: { selectDigitalHuman: (id: DigitalHumanId) => void; selectSession: (id: string) => void; openResource: (path: string) => void; newSession: () => void; browseFiles: () => void };
};

/** LangSmith-style ⌘K palette: one modal that jumps to digital humans, sessions, files, and actions. */
function CommandPalette({ open, onClose, digitalHumans, sessions, resources, actions }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState('');
  useEffect(() => { if (open) { setQuery(''); setActiveId(''); } }, [open]);
  if (!open) return null;
  const items: PaletteItem[] = [
    { id: 'action-new-session', group: '操作', label: '新建会话', icon: <Plus size={15} />, run: actions.newSession },
    { id: 'action-browse-files', group: '操作', label: '浏览项目文件', icon: <FolderOpen size={15} />, run: actions.browseFiles },
    ...digitalHumans.map((digitalHuman) => ({ id: `digital-human-${digitalHuman.id}`, group: '数字人', label: `${digitalHuman.displayName} · ${digitalHuman.role}`, hint: digitalHuman.tagline, icon: <span className={`agent-selector-mark digital-human-accent-${digitalHuman.avatar.accent}`} aria-hidden="true">{digitalHuman.avatar.initials}</span>, run: () => actions.selectDigitalHuman(digitalHuman.id) })),
    ...sessions.map((session) => ({ id: `session-${session.id}`, group: '会话', label: sessionTitle(session), hint: conversationTime(session.updatedAt), icon: <ChatCircle size={15} />, run: () => actions.selectSession(session.id) })),
    ...resources.map((resource) => ({ id: `resource-${resource.path}`, group: '项目文件', label: resourceTitle(resource.title), hint: resource.path, icon: <Folder size={15} />, run: () => actions.openResource(resource.path) })),
  ];
  const normalized = query.trim().toLocaleLowerCase();
  // 无查询时只给导航级入口（对齐 LangSmith：文件要搜索才出现），并限制每组行数。
  const visible = (normalized ? items.filter((item) => `${item.label} ${item.hint ?? ''}`.toLocaleLowerCase().includes(normalized)) : items.filter((item) => item.group !== '项目文件')).slice(0, 60);
  const groups: { name: string; items: PaletteItem[] }[] = [];
  for (const item of visible) {
    const group = groups.find((entry) => entry.name === item.group);
    if (group) group.items.push(item); else groups.push({ name: item.group, items: [item] });
  }
  if (!normalized) for (const group of groups) group.items = group.items.slice(0, 8);
  const active = visible.find((item) => item.id === activeId) ?? visible[0];
  const runItem = (item?: PaletteItem) => { if (!item) return; onClose(); item.run(); };
  return <div className="palette-backdrop" onClick={onClose}>
    <div className="palette" role="dialog" aria-modal="true" aria-label="搜索与跳转" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!visible.length) return;
        const index = visible.findIndex((item) => item.id === active?.id);
        const next = event.key === 'ArrowDown' ? (index + 1) % visible.length : (index - 1 + visible.length) % visible.length;
        setActiveId(visible[next]!.id);
        return;
      }
      if (event.key === 'Enter') { event.preventDefault(); runItem(active); }
    }}>
      <div className="palette-input-row"><MagnifyingGlass size={15} /><input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setActiveId(''); }} placeholder="搜索数字人、会话、文件…" aria-label="搜索数字人、会话、文件" /><kbd>Esc</kbd></div>
      <div className="palette-results">
        {groups.map((group) => <div key={group.name} role="group" aria-label={group.name}><div className="palette-group-label">{group.name}</div>{group.items.map((item) => <button type="button" key={item.id} className={item.id === active?.id ? 'palette-item palette-item-active' : 'palette-item'} onMouseEnter={() => setActiveId(item.id)} onClick={() => runItem(item)}>{item.icon}<span className="palette-item-label">{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}</button>)}</div>)}
        {!visible.length ? <p className="palette-empty">没有匹配的结果。</p> : null}
      </div>
      <footer className="palette-foot"><span>↑↓ 移动</span><span>Enter 选择</span><span>Esc 关闭</span></footer>
    </div>
  </div>;
}

type WorkspacePanelProps = {
  state: { workspace: WorkspaceSnapshot; digitalHumans: DigitalHumanDefinition[]; currentDigitalHumanId: DigitalHumanId; sessions: SessionRecord[]; currentSessionId: string; view: WorkspaceView; tree: FileTreeNode; filter: string; selectedResource: string; collapsedPaths: Set<string>; pending: boolean; refreshing: boolean; authUser?: AuthUser; open: boolean; animating: boolean };
  actions: { toggleOpen: () => void; selectDigitalHuman: (digitalHumanId: DigitalHumanId) => void; changeView: (view: WorkspaceView) => void; changeFilter: (value: string) => void; toggleResource: (path: string) => void; selectResource: (path: string) => void; selectSession: (id: string) => void; newSession: () => void; renameSession: (id: string, title: string) => Promise<void>; deleteSession: (id: string) => Promise<void>; refreshWorkspace: () => void; openPalette: () => void; logout: () => void };
};

function WorkspacePanel({ state, actions }: WorkspacePanelProps) {
  const { workspace, digitalHumans, currentDigitalHumanId, sessions, currentSessionId, view, tree, filter, selectedResource, collapsedPaths, pending, refreshing, authUser, open, animating } = state;
  const { toggleOpen: onToggleOpen, selectDigitalHuman: onSelectDigitalHuman, changeView: onViewChange, changeFilter: onFilterChange, toggleResource: onToggle, selectResource: onSelect, selectSession: onSelectSession, newSession: onNewSession, renameSession: onRenameSession, deleteSession: onDeleteSession, refreshWorkspace: onRefreshWorkspace, openPalette: onOpenPalette, logout: onLogout } = actions;
  const showingSessions = view === 'sessions';
  const currentDigitalHuman = digitalHumans.find((digitalHuman) => digitalHuman.id === currentDigitalHumanId);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const hasMatchingResource = treeHasMatch(tree, normalizedFilter);
  const handleTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]');
    if (!current) return;
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')];
    const index = items.indexOf(current);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'Home') return items[0]?.focus();
    if (event.key === 'End') return items.at(-1)?.focus();
    if (event.key === 'ArrowDown') return items[index + 1]?.focus();
    if (event.key === 'ArrowUp') return items[index - 1]?.focus();
    const expanded = current.getAttribute('aria-expanded');
    if (event.key === 'ArrowRight') {
      if (expanded === 'false') current.click();
      else if (expanded === 'true') items[index + 1]?.focus();
      return;
    }
    if (expanded === 'true') return current.click();
    const level = Number(current.getAttribute('aria-level') ?? 1);
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = items[cursor]!;
      if (Number(candidate.getAttribute('aria-level') ?? 1) < level) return candidate.focus();
    }
  };
  return (
    <aside id="project-workspace" className={['workspace-panel', open ? '' : 'workspace-panel-collapsed', animating ? 'workspace-panel-animating' : ''].filter(Boolean).join(' ')} data-state={open ? 'expanded' : 'collapsed'} data-collapsible="icon" aria-label="项目工作区">
      {open ? (
        <div className="workspace-panel-content">
          <header className="workspace-brand-header" aria-label="Pi 工作台">
            <div className="workspace-brand">
              <div className="workspace-brand-mark">π</div>
              <div className="workspace-brand-copy">
                <strong>Pi 工作台</strong>
                <span>本地数字人</span>
                <CaretDown size={13} aria-hidden="true" />
              </div>
            </div>
            <button type="button" className="workspace-toggle-button" data-sidebar="trigger" onClick={onToggleOpen} aria-controls="project-workspace" aria-expanded="true" aria-label="收起工作区 (⌘B)" title="收起工作区 (⌘B)">
              <SidebarSimple size={16} />
            </button>
          </header>
          <div className="workspace-nav-section">
            <button type="button" className="workspace-search-trigger" onClick={onOpenPalette} aria-keyshortcuts="meta+k ctrl+k"><MagnifyingGlass size={15} /><span>搜索</span><kbd>⌘K</kbd></button>
          </div>
          <nav className="workspace-tabs" aria-label="工作区视图">
            <button type="button" className={showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('sessions')} aria-current={showingSessions ? 'page' : undefined}>
              <ChatCircle size={14} weight={showingSessions ? 'fill' : 'regular'} />
              <span>会话</span>
              <small>{sessions.length}</small>
            </button>
            <button type="button" className={!showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('files')} aria-current={!showingSessions ? 'page' : undefined}>
              <FolderOpen size={14} weight={!showingSessions ? 'fill' : 'regular'} />
              <span>项目文件</span>
              <small>{workspace.resources.length}</small>
            </button>
          </nav>
          <div className="workspace-group" aria-label="数字人">
            <div className="workspace-group-header"><span>数字人</span></div>
            <div className="workspace-group-rows" role="listbox" aria-label="数字人列表">
              {digitalHumans.map((digitalHuman) => {
                const selected = digitalHuman.id === currentDigitalHumanId;
                return <button type="button" role="option" aria-selected={selected} key={digitalHuman.id} className={selected ? 'agent-row agent-row-active' : 'agent-row'} disabled={pending && !selected} onClick={() => onSelectDigitalHuman(digitalHuman.id)}>
                  <span className={`agent-selector-mark digital-human-accent-${digitalHuman.avatar.accent}`} aria-hidden="true">{digitalHuman.avatar.initials}</span>
                  <span className="agent-row-copy"><strong>{digitalHuman.displayName}</strong><small>{digitalHuman.role}</small></span>
                  {selected ? <Check size={13} weight="bold" aria-hidden="true" /> : null}
                </button>;
              })}
            </div>
          </div>
          <div id="workspace-view-panel" className="workspace-view-panel">
            {showingSessions ? (
              <>
                <div className="workspace-group-header"><span>会话</span><button type="button" className="workspace-group-action" onClick={onNewSession} aria-label="新建会话" title="新建会话"><Plus size={13} weight="bold" /></button></div>
                <SessionList sessions={sessions} currentSessionId={currentSessionId} pending={pending} onSelect={onSelectSession} onRename={onRenameSession} onDelete={onDeleteSession} />
              </>
            ) : (
              <>
                <div className="workspace-group-header"><span>项目文件</span></div>
                <div className="workspace-toolbar">
                  <label className="workspace-search">
                    <MagnifyingGlass size={14} />
                    <input value={filter} onChange={(event) => onFilterChange(event.target.value)} placeholder="筛选文件" aria-label="过滤 .pi 文件" />
                  </label>
                  <button type="button" className={refreshing ? 'workspace-refresh-button is-refreshing' : 'workspace-refresh-button'} onClick={onRefreshWorkspace} disabled={refreshing} aria-busy={refreshing} aria-label={refreshing ? '正在刷新项目资源' : '刷新项目资源'} title={refreshing ? '正在刷新' : '刷新项目资源'}><ArrowsClockwise size={14} /></button>
                </div>
                <div className="workspace-tree" role="tree" aria-label="Pi 项目文件树" onKeyDown={handleTreeKeyDown}>
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
      ) : (
        <nav className="workspace-rail" aria-label="工作区快速导航">
          <button type="button" className="rail-item rail-expand" onClick={onToggleOpen} aria-controls="project-workspace" aria-expanded="false" aria-label="展开工作区 (⌘B)" data-tip="展开 ⌘B"><SidebarSimple size={16} /></button>
          {currentDigitalHuman ? <button type="button" className="rail-item rail-mark" onClick={onToggleOpen} aria-label={`展开并切换到数字人 ${currentDigitalHuman.displayName}`} data-tip={`${currentDigitalHuman.displayName} · ${currentDigitalHuman.role}`}><span className={`agent-selector-mark digital-human-accent-${currentDigitalHuman.avatar.accent}`} aria-hidden="true">{currentDigitalHuman.avatar.initials}</span></button> : null}
          <button type="button" className="rail-item" onClick={onOpenPalette} aria-keyshortcuts="meta+k ctrl+k" aria-label="搜索 (⌘K)" data-tip="搜索 ⌘K"><MagnifyingGlass size={16} /></button>
          <button type="button" className={showingSessions ? 'rail-item rail-item-active' : 'rail-item'} onClick={() => { onViewChange('sessions'); onToggleOpen(); }} aria-label="展开会话列表" data-tip="会话"><ChatCircle size={16} weight={showingSessions ? 'fill' : 'regular'} /></button>
          <button type="button" className={!showingSessions ? 'rail-item rail-item-active' : 'rail-item'} onClick={() => { onViewChange('files'); onToggleOpen(); }} aria-label="展开项目文件" data-tip="项目文件"><FolderOpen size={16} weight={!showingSessions ? 'fill' : 'regular'} /></button>
          {authUser ? (
            <>
              <button type="button" className="rail-item rail-bottom" onClick={onLogout} aria-label="退出飞书登录" data-tip="退出登录"><SignOut size={16} /></button>
              <span className="rail-item rail-avatar" data-tip={authUser.name} aria-hidden="true">{authUser.name.slice(0, 1)}</span>
            </>
          ) : null}
        </nav>
      )}
    </aside>
  );
}

function WorkbenchApp({ authUser, onLogout }: { authUser?: AuthUser; onLogout: () => void }) {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(emptyWorkspace);
  const [digitalHumanId, setDigitalHumanId] = useState<DigitalHumanId>('');
  const [sessionId, setSessionId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ConversationItem[]>([]);
  const [pending, setPending] = useState(false);
  const [selectedResource, setSelectedResource] = useState('');
  const [resourceFilter, setResourceFilter] = useState('');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('files');
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [sessionRecords, setSessionRecords] = useState<SessionRecord[]>([]);
  const [draftSessionIds, setDraftSessionIds] = useState<Set<string>>(() => new Set());
  const [sessionsReady, setSessionsReady] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState('');
  const [feedbackPending, setFeedbackPending] = useState('');
  const [error, setError] = useState('');
  const [resourceDocument, setResourceDocument] = useState<AgentResourceDocument | null>(null);
  const [resourceLoading, setResourceLoading] = useState(false);
  const [resourceError, setResourceError] = useState('');
  const [workspaceRefreshing, setWorkspaceRefreshing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState('');
  const resourceRequestRef = useRef(0);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const followConversationRef = useRef(true);
  const workspaceAnimTimerRef = useRef<number | undefined>(undefined);
  const [workspaceAnimating, setWorkspaceAnimating] = useState(false);
  /** Animates the sidebar width only during expand/collapse; keeps drag-resize instant. */
  const toggleWorkspace = () => {
    setWorkspaceAnimating(true);
    window.clearTimeout(workspaceAnimTimerRef.current);
    workspaceAnimTimerRef.current = window.setTimeout(() => setWorkspaceAnimating(false), 220);
    setWorkspaceOpen((value) => !value);
  };
  useEffect(() => () => window.clearTimeout(workspaceAnimTimerRef.current), []);
  const fileTree = useMemo(() => buildFileTree(workspace.resources), [workspace.resources]);
  const flatResources = useMemo(() => flattenResources(fileTree), [fileTree]);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashPrompts = useMemo(() => flatResources.filter((resource) => resource.kind === 'prompt'), [flatResources]);
  const slashQuery = prompt.startsWith('/') ? prompt.slice(1) : null;
  const slashMatches = useMemo(() => (slashQuery === null ? [] : slashPrompts.filter((resource) => `${resourceTitle(resource.title)} ${resource.path}`.toLocaleLowerCase().includes(slashQuery.toLocaleLowerCase()))), [slashQuery, slashPrompts]);
  const slashOpen = slashQuery !== null && !pending && sessionsReady;
  useEffect(() => setSlashIndex(0), [slashQuery]);

  /** Fills the composer with a .pi/prompts template, LangSmith "type / for skills" style. */
  async function chooseSlashPrompt(resource: AgentResourceSummary) {
    try {
      const response = await fetch(`/api/v1/digital-humans/resource?path=${encodeURIComponent(resource.path)}`);
      if (!response.ok) throw new Error('prompt fetch failed');
      const document = (await response.json()) as AgentResourceDocument;
      setPrompt(document.content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim());
    } catch {
      setPrompt(resourceTitle(resource.title));
    }
    setSlashIndex(0);
    requestAnimationFrame(() => promptInputRef.current?.focus());
  }
  const digitalHumans = workspace.digitalHumans;
  const currentDigitalHuman = digitalHumans.find((digitalHuman) => digitalHuman.id === digitalHumanId);
  const sessions = useMemo(() => sortSessionRecords(sessionRecords), [sessionRecords]);
  const totalQuestions = useMemo(() => sessions.reduce((total, session) => total + session.messages.filter((message) => message.kind === 'user').length, 0), [sessions]);
  const currentSession = sessionRecords.find((session) => session.id === sessionId);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleWorkspace();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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

  // After the first message the composer FLIPs from the welcome flow to the bottom dock; restore focus once it lands.
  const hadMessagesRef = useRef(false);
  useEffect(() => {
    const hadMessages = hadMessagesRef.current;
    hadMessagesRef.current = messages.length > 0;
    if (hadMessages || messages.length === 0) return;
    const focusTimer = window.setTimeout(() => promptInputRef.current?.focus(), 380);
    return () => window.clearTimeout(focusTimer);
  }, [messages.length]);

  async function refreshWorkspace() {
    setWorkspaceRefreshing(true);
    try {
      const response = await fetch('/api/v1/digital-humans/workspace', { cache: 'no-store' });
      if (!response.ok) throw new Error('数字人工作区暂时无法读取');
      const snapshot = await response.json() as WorkspaceSnapshot;
      if (!snapshot.digitalHumans.length) throw new Error('项目没有定义数字人');
      setWorkspace(snapshot);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '数字人工作区暂时无法读取');
    } finally {
      setWorkspaceRefreshing(false);
    }
  }

  useEffect(() => {
    let active = true;
    const initialize = async () => {
      setWorkspaceRefreshing(true);
      setSessionsReady(false);
      try {
        const response = await fetch('/api/v1/digital-humans/workspace', { cache: 'no-store' });
        if (!response.ok) throw new Error('数字人工作区暂时无法读取');
        const snapshot = await response.json() as WorkspaceSnapshot;
        const firstDigitalHuman = snapshot.digitalHumans[0];
        if (!firstDigitalHuman) throw new Error('项目没有定义数字人');
        let records = await fetchSessionRecords(firstDigitalHuman.id);
        let drafts = new Set<string>();
        if (!records.length) {
          const draft = emptySessionRecord(firstDigitalHuman.id);
          records = [draft];
          drafts = new Set([draft.id]);
        }
        if (!active) return;
        const initial = records[0]!;
        followConversationRef.current = true;
        setWorkspace(snapshot);
        setSelectedResource(snapshot.resources[0]?.path ?? '');
        setDigitalHumanId(firstDigitalHuman.id);
        setSessionRecords(records);
        setDraftSessionIds(drafts);
        setSessionId(initial.id);
        setMessages(initial.messages);
      } catch (requestError) {
        if (active) setError(requestError instanceof Error ? requestError.message : '数字人工作区暂时无法读取');
      } finally {
        if (active) {
          setWorkspaceRefreshing(false);
          setSessionsReady(true);
        }
      }
    };
    void initialize();
    return () => { active = false; };
  }, []);

  async function selectDigitalHuman(nextDigitalHumanId: DigitalHumanId) {
    if (pending || nextDigitalHumanId === digitalHumanId) return;
    setSessionsReady(false);
    setError('');
    closeResourceViewer();
    try {
      let records = await fetchSessionRecords(nextDigitalHumanId);
      if (!records.length) {
        const draft = emptySessionRecord(nextDigitalHumanId);
        records = [draft];
        setDraftSessionIds(new Set([draft.id]));
      } else {
        setDraftSessionIds(new Set());
      }
      const initial = records[0]!;
      followConversationRef.current = true;
      setDigitalHumanId(nextDigitalHumanId);
      setSessionRecords(records);
      setSessionId(initial.id);
      setMessages(initial.messages);
      setWorkspaceView('sessions');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '数字人会话暂时无法读取');
    } finally {
      setSessionsReady(true);
    }
  }

  async function syncSession(id: string) {
    const wasDraft = draftSessionIds.has(id);
    try {
      const record = await fetchSessionRecord(id, digitalHumanId);
      setSessionRecords((current) => sortSessionRecords(current.some((session) => session.id === id) ? current.map((session) => session.id === id ? record : session) : [...current, record]));
      setDraftSessionIds((current) => { const next = new Set(current); next.delete(id); return next; });
      if (id === sessionId) setMessages(record.messages);
      if (wasDraft) void refreshWorkspace();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '数字人会话同步失败');
    }
  }

  async function copyAnswer(messageId: string, text: string) {
    if (!text) return;
    try {
      await copyText(text);
      setCopiedMessageId(messageId);
      window.setTimeout(() => setCopiedMessageId((current) => current === messageId ? '' : current), 1600);
    } catch {
      setError('回答复制失败，请检查浏览器剪贴板权限');
    }
  }

  async function updateFeedback(messageId: string, feedback: AgentFeedback | null) {
    if (!sessionId) return;
    setFeedbackPending(messageId);
    try {
      const response = await fetch(`/api/v1/digital-humans/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/feedback`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ digitalHumanId, feedback }),
      });
      if (!response.ok) throw new Error('回答反馈暂时无法保存');
      const record = await response.json() as SessionRecord;
      setSessionRecords((current) => sortSessionRecords(current.map((session) => session.id === record.id ? record : session)));
      if (record.id === sessionId) setMessages(record.messages);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '回答反馈暂时无法保存');
    } finally {
      setFeedbackPending('');
    }
  }

  function resetSession() {
    if (pending || !sessionsReady) return;
    if (currentSession && currentSession.messages.length === 0) {
      setWorkspaceView('sessions');
      closeResourceViewer();
      return;
    }
    const record = emptySessionRecord(digitalHumanId, sessionRecords.length);
    setDraftSessionIds((current) => new Set(current).add(record.id));
    setSessionRecords((current) => [record, ...current]);
    followConversationRef.current = true;
    setSessionId(record.id);
    setMessages(record.messages);
    setError('');
    closeResourceViewer();
  }

  async function renameSession(id: string, title: string) {
    try {
      const record = draftSessionIds.has(id) ? { ...sessionRecords.find((session) => session.id === id)!, title, updatedAt: new Date().toISOString() } : await renameSessionRecord(id, digitalHumanId, title);
      setSessionRecords((current) => sortSessionRecords(current.map((session) => session.id === id ? record : session)));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '会话名称暂时无法保存');
      throw requestError;
    }
  }

  async function deleteSession(id: string) {
    try {
      if (!draftSessionIds.has(id)) await deleteSessionRecord(id, digitalHumanId);
      let remaining = sessionRecords.filter((session) => session.id !== id);
      setDraftSessionIds((current) => { const next = new Set(current); next.delete(id); return next; });
      if (!remaining.length) {
        const draft = emptySessionRecord(digitalHumanId);
        remaining = [draft];
        setDraftSessionIds(new Set([draft.id]));
      }
      setSessionRecords(remaining);
      if (id === sessionId) {
        const next = remaining[0]!;
        setSessionId(next.id);
        setMessages(next.messages);
        closeResourceViewer();
      }
      void refreshWorkspace();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '会话暂时无法删除');
    }
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
    setWorkspaceView('files');
    setWorkspaceOpen(true);
    setResourceDocument(null);
    setResourceError('');
    setResourceLoading(true);
    try {
      const response = await fetch(`/api/v1/digital-humans/resource?path=${encodeURIComponent(path)}`);
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
    if (!text || pending || !sessionsReady || !sessionId || !digitalHumanId || !workspace.model.enabled) return;
    followConversationRef.current = true;
    const userId = `${Date.now()}-user`;
    const thinkingId = `${Date.now()}-thinking`;
    const assistantId = `${Date.now()}-assistant`;
    const createdAt = new Date().toISOString();
    const optimisticUser: UserMessageItem = { id: userId, kind: 'user', text, turnId: assistantId, createdAt };
    setPrompt('');
    setError('');
    setMessages((current) => [...current, optimisticUser, { id: thinkingId, kind: 'thinking', turnId: assistantId, text: '', status: 'streaming', createdAt }, { id: assistantId, kind: 'assistant', turnId: assistantId, text: '', createdAt, persisted: false, digitalHumanId } as AssistantMessageItem]);
    setSessionRecords((current) => sortSessionRecords(current.map((session) => session.id === sessionId ? { ...session, updatedAt: createdAt, messages: [...session.messages, optimisticUser] } : session)));
    setPending(true);
    let streamedProcess = createLiveTurnProcess();
    let streamFrame: number | null = null;
    const flushStream = () => {
      streamFrame = null;
      setMessages((current) => current.map((item) => {
        if (item.id === thinkingId && item.kind === 'thinking') return { ...item, text: streamedProcess.thinking };
        if (item.id === assistantId && item.kind === 'assistant') return { ...item, text: streamedProcess.answer, streamEvents: streamedProcess.events, digitalHumanId };
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
      const response = await fetch('/api/v1/digital-humans/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ message: text, digitalHumanId, sessionId, turnId: assistantId, thinkingLevel: thinkingEnabled ? enabledThinkingLevel : 'off', ...(selectedModel ? { model: selectedModel } : {}), debug: true }) });
      if (!response.ok) throw new Error('数字人网关返回错误');
      const data = await consumeAgentStream(response, (event) => {
        streamedProcess = applyAgentStreamEvent(streamedProcess, event);
        if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'event') scheduleStreamFlush();
      });
      cancelStreamFlush();
      setMessages((current) => current.map((item) => {
        if (item.id === thinkingId && item.kind === 'thinking') return { ...item, status: 'complete', text: streamedProcess.thinking };
        if (item.id === assistantId && item.kind === 'assistant') return { ...item, text: data.answer, response: data, createdAt: data.createdAt };
        return item;
      }));
      await syncSession(sessionId);
    } catch (requestError) {
      cancelStreamFlush();
      setError(requestError instanceof Error ? requestError.message : '数字人网关暂时不可用');
    } finally {
      cancelStreamFlush();
      setPending(false);
    }
  }

  if (!currentDigitalHuman) {
    return <main className="auth-loading" aria-live="polite"><span className="auth-loading-mark">人</span><strong>正在加载数字人档案</strong><span>{error || '正在读取项目定义与能力档案。'}</span></main>;
  }

  const showWelcome = messages.length === 0;
  /** One composer, two placements: in the welcome flow when empty, docked at the bottom once chatting. layoutId FLIPs between them. */
  const composerNode = (
    <motion.div layoutId="composer" className={showWelcome ? 'composer-wrap composer-welcome' : 'composer-wrap'} transition={{ type: 'spring', duration: 0.5, bounce: 0.1 }}>
      <div className="composer">
        <AnimatePresence initial={false}>{slashOpen ? (
          <motion.div className="slash-panel" role="listbox" aria-label="提示词模板" initial={{ opacity: 0, y: 4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 4, scale: 0.98, transition: { duration: 0.1, ease: motionEase } }} transition={{ duration: 0.16, ease: motionEase }} style={{ transformOrigin: 'bottom left' }}>
            {slashMatches.length ? slashMatches.map((resource, index) => (
              <button type="button" role="option" aria-selected={index === slashIndex} key={resource.path} className={index === slashIndex ? 'slash-option slash-option-active' : 'slash-option'} onMouseEnter={() => setSlashIndex(index)} onClick={() => void chooseSlashPrompt(resource)}>
                <FileText size={13} aria-hidden="true" /><span className="slash-option-copy"><strong>{resourceTitle(resource.title)}</strong><small>{resource.path}</small></span>
              </button>
            )) : <p className="slash-empty">没有匹配的提示词模板。</p>}
          </motion.div>
        ) : null}</AnimatePresence>
        <textarea ref={promptInputRef} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => {
          if (slashOpen && slashMatches.length) {
            if (event.key === 'ArrowDown') { event.preventDefault(); setSlashIndex((index) => (index + 1) % slashMatches.length); return; }
            if (event.key === 'ArrowUp') { event.preventDefault(); setSlashIndex((index) => (index - 1 + slashMatches.length) % slashMatches.length); return; }
            if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); void chooseSlashPrompt(slashMatches[slashIndex] ?? slashMatches[0]!); return; }
            if (event.key === 'Escape') { event.preventDefault(); setPrompt(''); return; }
          }
          if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
        }} placeholder={sessionsReady ? `向${currentDigitalHuman.displayName}提问，或输入 / 使用提示词…` : '正在加载会话…'} aria-label={`向${currentDigitalHuman.displayName}提问`} rows={1} disabled={!sessionsReady || pending || !workspace.model.enabled} />
        <div className="composer-toolbar">
          <button type="button" className="composer-tool-button" onClick={() => openWorkspace('files')}><FolderOpen size={14} />浏览文件</button>
          <button type="button" className={thinkingEnabled ? 'composer-tool-button composer-thinking-toggle composer-tool-active' : 'composer-tool-button composer-thinking-toggle'} onClick={() => setThinkingEnabled((enabled) => !enabled)} aria-pressed={thinkingEnabled} aria-label={thinkingEnabled ? '下一轮已开启深入思考，点击关闭' : '为下一轮开启深入思考'} title={thinkingEnabled ? '下一轮使用 minimal reasoning' : '下一轮不请求 reasoning'}><span className="thinking-switch-indicator" aria-hidden="true" />深入思考</button>
          <span className="composer-toolbar-spacer" />
          {workspace.model.available?.length ? (
            <ModelPicker models={workspace.model.available} current={selectedModel || workspace.model.model || ''} disabled={!workspace.model.enabled} onSelect={setSelectedModel} />
          ) : (
            <div className="model-status" role="status" aria-label={`当前模型 ${workspace.model.model ?? '未配置'}`} title={workspace.model.providerConfigured ? '模型已就绪' : '模型未配置'}><span aria-hidden="true" /><span className="model-choice-label">{workspace.model.model ?? '未配置'}</span></div>
          )}
          <button type="button" className="send-button" onClick={() => void send()} disabled={pending || !sessionsReady || !prompt.trim() || !workspace.model.enabled} aria-label="发送"><ArrowUpRight size={18} weight="bold" /></button>
        </div>
      </div>
      <div className="composer-foot"><span>按 Enter 发送 · Shift + Enter 换行</span><span><span className="composer-lock" />只读上下文</span></div>
    </motion.div>
  );

  return (
    <div className={workspaceOpen ? 'workbench-shell' : 'workbench-shell workbench-shell-workspace-collapsed'}>
      <WorkspacePanel state={{ workspace, digitalHumans, currentDigitalHumanId: digitalHumanId, sessions, currentSessionId: sessionId, view: workspaceView, tree: fileTree, filter: resourceFilter, selectedResource, collapsedPaths, pending, refreshing: workspaceRefreshing, authUser, open: workspaceOpen, animating: workspaceAnimating }} actions={{ toggleOpen: toggleWorkspace, selectDigitalHuman: (nextDigitalHumanId) => { void selectDigitalHuman(nextDigitalHumanId); }, changeView: setWorkspaceView, changeFilter: setResourceFilter, toggleResource: togglePath, selectResource: openResource, selectSession, newSession: resetSession, renameSession, deleteSession, refreshWorkspace: () => { if (!workspaceRefreshing) void refreshWorkspace(); }, openPalette: () => setPaletteOpen(true), logout: onLogout }} />
      <main className="session-panel">
        <AnimatePresence initial={false} mode="wait">{resourceDocument || resourceLoading || resourceError ? <ResourceViewer key="resource" document={resourceDocument} loading={resourceLoading} error={resourceError} onClose={closeResourceViewer} /> : <motion.section key="conversation" className="conversation-stage" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0, transition: { duration: 0.18, ease: motionEase } }} exit={{ opacity: 0, x: 4, transition: { duration: 0.08, ease: motionEase } }}>
          {sessionsReady ? <div className="usage-bar"><Info size={13} weight="fill" aria-hidden="true" /><span>{currentDigitalHuman.displayName} 累计 {sessions.length} 个会话 · {totalQuestions} 次提问 · 项目资源 {workspace.resources.length} 个文件</span></div> : null}
          <header className="conversation-header"><div><strong>{currentDigitalHuman.displayName} · {currentDigitalHuman.role}</strong><span>{currentDigitalHuman.tagline} · {currentSession ? sessionTitle(currentSession) : '新对话'} · {currentSession?.messages.filter((message) => message.kind === 'user').length ?? 0} 次提问</span></div><div className="conversation-header-actions"><span className="read-only-status"><ShieldCheck size={14} weight="duotone" />{currentDigitalHuman.capabilityLabel}</span><button type="button" className={configOpen ? 'config-toggle config-toggle-active' : 'config-toggle'} onClick={() => setConfigOpen((open) => !open)} aria-pressed={configOpen} aria-label={configOpen ? '关闭数字人配置面板' : '打开数字人配置面板'}><SlidersHorizontal size={14} />配置</button></div></header>
          <div className="conversation-scroll" ref={conversationScrollRef} onScroll={(event) => {
            const node = event.currentTarget;
            followConversationRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 72;
          }}>
            {messages.length === 0 ? (
              <motion.div className="welcome-state" variants={welcomeGroup} initial="hidden" animate="show">
                <motion.div className={`welcome-mark digital-human-accent-${currentDigitalHuman.avatar.accent}`} variants={welcomeItem}><span className="pi-welcome-glyph">{currentDigitalHuman.avatar.initials}</span></motion.div>
                <motion.h1 variants={welcomeItem}>{currentDigitalHuman.welcome.title}</motion.h1>
                <motion.p variants={welcomeItem}>{currentDigitalHuman.welcome.description}</motion.p>
                <div className="welcome-suggestions" aria-label="建议问题">
                  {currentDigitalHuman.welcome.suggestions.map((suggestion) => <motion.button type="button" key={suggestion} variants={welcomeItem} onClick={() => { setPrompt(suggestion); requestAnimationFrame(() => promptInputRef.current?.focus()); }}>{suggestion}<CaretRight size={13} /></motion.button>)}
                </div>
                {composerNode}
              </motion.div>
            ) : (
              <div className="message-list">
                <ConversationStream digitalHuman={currentDigitalHuman} messages={messages} copiedMessageId={copiedMessageId} feedbackPending={feedbackPending} onCopy={copyAnswer} onFeedback={updateFeedback} onOpenResource={openResource} />
              </div>
            )}
          </div>
          {!showWelcome ? composerNode : null}
        </motion.section>}</AnimatePresence>
        <AnimatePresence initial={false}>{configOpen ? <DigitalHumanConfigPanel key="config" digitalHuman={currentDigitalHuman} model={workspace.model} onClose={() => setConfigOpen(false)} /> : null}</AnimatePresence>
      </main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} digitalHumans={digitalHumans} sessions={sessions} resources={flatResources} actions={{ selectDigitalHuman: (id) => { void selectDigitalHuman(id); }, selectSession: (id) => { setWorkspaceOpen(true); setWorkspaceView('sessions'); selectSession(id); }, openResource: (path) => void openResource(path), newSession: () => { setWorkspaceOpen(true); setWorkspaceView('sessions'); resetSession(); }, browseFiles: () => openWorkspace('files') }} />
      <AnimatePresence>{error && <motion.div className="error-toast" role="alert" initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1, transition: { duration: 0.18, ease: motionEase } }} exit={{ opacity: 0, y: 6, scale: 0.98, transition: { duration: 0.12, ease: motionEase } }}><WarningCircle size={17} weight="fill" /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="关闭错误提示"><X size={14} /></button></motion.div>}</AnimatePresence>
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
  return <MotionConfig reducedMotion="user"><WorkbenchApp authUser={authStatus.user} onLogout={async () => {
    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include' });
    setAuthStatus((current) => current ? { ...current, authenticated: false, user: undefined } : current);
  }} /></MotionConfig>;
}

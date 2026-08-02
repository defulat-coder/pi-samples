import { useEffect, useMemo, useState } from 'react';
import type { AgentChatResponse, AgentChatStreamEvent, AgentEventSummary, AgentResourceSummary } from '@pi-workbench/contracts';
import {
  ArrowUpRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatCircle,
  FileText,
  Folder,
  FolderOpen,
  MagnifyingGlass,
  Plus,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

type UserMessageItem = {
  id: string;
  kind: 'user';
  text: string;
};

type ThinkingMessageItem = {
  id: string;
  kind: 'thinking';
  turnId: string;
  text: string;
  status: 'streaming' | 'complete';
};

type AssistantMessageItem = {
  id: string;
  kind: 'assistant';
  turnId: string;
  text: string;
  response?: AgentChatResponse;
};

/** The stream's semantic output stays split into sibling UI items. */
type ConversationItem = UserMessageItem | ThinkingMessageItem | AssistantMessageItem;

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
  resource?: AgentResourceSummary;
};

type SessionRecord = {
  id: string;
  messages: ConversationItem[];
};

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

const starterPrompts = [
  { label: '讲清一次会话', prompt: '请解释一次 Pi 智能体会话从创建到结束的生命周期，并引用对应资源。' },
  { label: '列出可用工具', prompt: '当前智能体有哪些工具权限？哪些事情明确不能做？' },
  { label: '检阅 .pi 文件树', prompt: '请按目录结构总结当前 .pi/ 下的技能、提示词和知识文件。' },
  { label: '回答应包含什么', prompt: '一个可验证的智能体回答应该包含哪些字段？' },
];

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

function buildFileTree(resources: AgentResourceSummary[]): FileTreeNode {
  const root: FileTreeNode = { name: '.pi', path: '.pi', kind: 'folder', children: [] };
  for (const resource of resources) {
    const parts = resource.path.split('/')[0] === '.pi' ? resource.path.split('/').slice(1) : resource.path.split('/');
    let cursor = root;
    parts.forEach((part, index) => {
      const path = [root.path, ...parts.slice(0, index + 1)].join('/');
      const isFile = index === parts.length - 1;
      let child = cursor.children.find((item) => item.path === path);
      if (!child) {
        child = { name: part, path, kind: isFile ? 'file' : 'folder', children: [], resource: isFile ? resource : undefined };
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
  return root;
}

function countFiles(node: FileTreeNode): number {
  return node.kind === 'file' ? 1 : node.children.reduce((total, child) => total + countFiles(child), 0);
}

function collectCollapsedFolders(node: FileTreeNode, depth = 0, paths: string[] = []): string[] {
  if (node.kind === 'folder' && depth >= 2) paths.push(node.path);
  node.children.forEach((child) => collectCollapsedFolders(child, depth + 1, paths));
  return paths;
}

function treeHasMatch(node: FileTreeNode, query: string): boolean {
  if (!query) return true;
  const value = `${node.name} ${node.path} ${node.resource?.title ?? ''}`.toLocaleLowerCase();
  return value.includes(query) || node.children.some((child) => treeHasMatch(child, query));
}

function fileKindLabel(resource?: AgentResourceSummary) {
  if (resource?.kind === 'skill') return 'S';
  if (resource?.kind === 'prompt') return 'P';
  return 'MD';
}

function FileTree({ node, depth, filter, collapsedPaths, selectedResource, onToggle, onSelect }: { node: FileTreeNode; depth: number; filter: string; collapsedPaths: Set<string>; selectedResource: string; onToggle: (path: string) => void; onSelect: (path: string) => void }) {
  const query = filter.trim().toLocaleLowerCase();
  if (query && !treeHasMatch(node, query)) return null;
  if (node.kind === 'file' && node.resource) {
    const isSelected = selectedResource === node.path;
    return <button className={isSelected ? 'tree-row tree-file selected' : 'tree-row tree-file'} style={{ paddingLeft: `${12 + depth * 10}px` }} onClick={() => onSelect(node.path)} title={node.path}><span className={`tree-file-kind tree-file-kind-${node.resource.kind}`}>{fileKindLabel(node.resource)}</span><span className="tree-file-copy"><strong>{node.name}</strong><small>{resourceTitle(node.resource.title)}</small></span></button>;
  }

  const isOpen = Boolean(query) || !collapsedPaths.has(node.path);
  return <div className="tree-node"><button className="tree-row tree-folder" style={{ paddingLeft: `${12 + depth * 10}px` }} onClick={() => onToggle(node.path)} aria-expanded={isOpen}><span className="tree-folder-icon">{isOpen ? <FolderOpen size={16} weight="duotone" /> : <Folder size={16} weight="duotone" />}</span><span className="tree-file-copy"><strong>{node.name}</strong><small>{countFiles(node)} 个文件</small></span>{isOpen ? <CaretDown size={13} /> : <CaretRight size={13} />}</button>{isOpen && <div className="tree-children">{node.children.map((child) => <FileTree key={child.path} node={child} depth={depth + 1} filter={filter} collapsedPaths={collapsedPaths} selectedResource={selectedResource} onToggle={onToggle} onSelect={onSelect} />)}</div>}</div>;
}

function SourceList({ response }: { response: AgentChatResponse }) {
  if (!response.sources.length) return <div className="empty-source">本次没有额外文件证据</div>;
  return <div className="source-list">{response.sources.map((source) => <div className="source-row" key={source.ref}><span className="source-kind">MD</span><span><strong>{resourceTitle(source.title)}</strong><small>{source.ref}</small></span></div>)}</div>;
}

function ThinkingMessage({ message }: { message: ThinkingMessageItem }) {
  if (!message.text) return null;
  const isWorking = message.status === 'streaming';
  return <section className="thinking-layer" aria-label="思考过程"><div className="thinking-layer-marker" aria-hidden="true">∴</div><details className="thinking-trace" open={isWorking}><summary>思考过程 · {message.text.length} 字符</summary><pre>{message.text}</pre></details></section>;
}

function AssistantMessage({ message }: { message: AssistantMessageItem }) {
  const isWorking = !message.response;
  return <article className="message message-assistant"><div className="message-avatar"><span className="agent-avatar-mark">π</span></div><div className="message-body"><div className="message-meta"><strong>Pi 智能体</strong><span>{isWorking ? '处理中' : '刚刚'}</span></div>{message.text ? <div className="markdown-body"><Markdown remarkPlugins={[remarkGfm]}>{message.text}</Markdown></div> : isWorking && <div className="typing-line"><i /><i /><i /></div>}{message.response && <div className="message-evidence"><div className="evidence-head"><span>依据</span><span className={`response-tag response-tag-${message.response.source === 'pi-coding-agent' ? 'live' : 'local'}`}>{responseSourceLabel(message.response.source)}</span><span className="route-tag">路径 · {routeLabel(message.response.route)}</span></div><SourceList response={message.response} /></div>}</div></article>;
}

function UserMessage({ message }: { message: UserMessageItem }) {
  return <article className="message message-user"><div className="message-body"><div className="message-meta"><strong>你</strong><span>刚刚</span></div><p>{message.text}</p></div></article>;
}

function SessionList({ sessions, currentSessionId, pending, onSelect }: { sessions: SessionRecord[]; currentSessionId: string; pending: boolean; onSelect: (id: string) => void }) {
  return <div className="workspace-session-list" aria-label="会话列表"><div className="workspace-list-caption"><span>会话列表</span><span>共 {sessions.length} 个</span></div>{sessions.length ? <div className="session-rows">{sessions.map((session) => { const isCurrent = session.id === currentSessionId; const messageCount = session.messages.filter((message) => message.kind === 'user').length; return <button className={isCurrent ? 'session-row session-row-current' : 'session-row'} key={session.id} onClick={() => onSelect(session.id)} disabled={pending && !isCurrent}><span className="session-row-icon"><ChatCircle size={15} weight={isCurrent ? 'fill' : 'duotone'} /></span><span className="session-row-copy"><strong>{sessionTitle(session.messages)}</strong><small>{session.id} · {messageCount} 次提问</small></span><span className="session-row-state">{isCurrent ? '当前' : '已保存'}</span></button>; })}</div> : <div className="session-empty"><ChatCircle size={17} /><strong>暂无会话</strong><span>开始对话后，会话会显示在这里。</span></div>}</div>;
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
            <div className="workspace-brand-mark">π</div>
            <div className="workspace-brand-copy">
              <strong>Pi 工作台</strong>
              <span>本地智能体</span>
            </div>
          </header>
          <div className="workspace-actions">
            <button type="button" className="new-session-button workspace-new-session" onClick={onNewSession}>
              <Plus size={14} weight="bold" />
              新建会话
            </button>
            <span className="workspace-session-chip">
              <span>当前会话</span>
              {currentSessionId}
            </span>
          </div>
          <header className="workspace-header">
            <div className="workspace-brand">
              <div className="workspace-symbol">{showingSessions ? <ChatCircle size={18} weight="duotone" /> : <FolderOpen size={18} weight="duotone" />}</div>
              <div>
                <span className="workspace-kicker">工作区</span>
                <h2>{showingSessions ? '会话' : '项目文件'}</h2>
              </div>
            </div>
            <div className="workspace-count">
              <strong>{showingSessions ? sessions.length : workspace.resources.length}</strong>
              <span>{showingSessions ? '个会话' : '个文件'}</span>
            </div>
          </header>
          <nav className="workspace-tabs" aria-label="工作区视图">
            <button className={showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('sessions')} aria-selected={showingSessions}>
              <ChatCircle size={14} weight={showingSessions ? 'fill' : 'regular'} />
              <span>会话</span>
              <small>{sessions.length}</small>
            </button>
            <button className={!showingSessions ? 'workspace-tab workspace-tab-active' : 'workspace-tab'} onClick={() => onViewChange('files')} aria-selected={!showingSessions}>
              <FolderOpen size={14} weight={!showingSessions ? 'fill' : 'regular'} />
              <span>项目文件</span>
              <small>{workspace.resources.length}</small>
            </button>
          </nav>
          {showingSessions ? (
            <SessionList sessions={sessions} currentSessionId={currentSessionId} pending={pending} onSelect={onSelectSession} />
          ) : (
            <>
              <div className="workspace-root">
                <FolderOpen size={15} weight="duotone" />
                <strong>.pi</strong>
                <span>本地上下文</span>
              </div>
              <div className="workspace-toolbar">
                <label className="workspace-search">
                  <MagnifyingGlass size={14} />
                  <input value={filter} onChange={(event) => onFilterChange(event.target.value)} placeholder="筛选文件" aria-label="过滤 .pi 文件" />
                </label>
                <span className="workspace-policy">只读</span>
              </div>
              <div className="workspace-tree" aria-label="Pi 项目文件树">
                <FileTree node={tree} depth={0} filter={filter} collapsedPaths={collapsedPaths} selectedResource={selectedResource} onToggle={onToggle} onSelect={onSelect} />
              </div>
            </>
          )}
        </div>
      ) : null}
    </aside>
  );
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot>(fallbackWorkspace);
  const [sessionId, setSessionId] = useState(newSessionId);
  const [prompt, setPrompt] = useState('');
  const [messages, setMessages] = useState<ConversationItem[]>([]);
  const [pending, setPending] = useState(false);
  const [selectedResource, setSelectedResource] = useState(fallbackResources[0]!.path);
  const [resourceFilter, setResourceFilter] = useState('');
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('files');
  const [workspaceOpen, setWorkspaceOpen] = useState(true);
  const [sessionHistory, setSessionHistory] = useState<SessionRecord[]>([]);
  const [showThinking, setShowThinking] = useState(true);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const fileTree = useMemo(() => buildFileTree(workspace.resources), [workspace.resources]);
  const sessions = useMemo(() => [{ id: sessionId, messages }, ...sessionHistory.filter((session) => session.id !== sessionId)], [messages, sessionHistory, sessionId]);

  useEffect(() => {
    setCollapsedPaths(new Set(collectCollapsedFolders(fileTree)));
  }, [fileTree]);

  useEffect(() => {
    fetch('/api/v1/agent/workspace').then(async (response) => {
      if (!response.ok) throw new Error('workspace unavailable');
      return response.json() as Promise<WorkspaceSnapshot>;
    }).then(setWorkspace).catch(() => undefined);
  }, []);

  function archiveCurrentSession() {
    setSessionHistory((current) => [{ id: sessionId, messages }, ...current.filter((session) => session.id !== sessionId)].slice(0, 11));
  }

  function resetSession() {
    archiveCurrentSession();
    setSessionId(newSessionId());
    setMessages([]);
    setError('');
  }

  function selectSession(nextSessionId: string) {
    if (pending || nextSessionId === sessionId) return;
    const target = sessionHistory.find((session) => session.id === nextSessionId);
    if (!target) return;
    setSessionHistory((current) => [{ id: sessionId, messages }, ...current.filter((session) => session.id !== sessionId && session.id !== nextSessionId)].slice(0, 11));
    setSessionId(target.id);
    setMessages(target.messages);
    setError('');
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

  async function send(message = prompt) {
    const text = message.trim();
    if (!text || pending) return;
    const userId = `${Date.now()}-user`;
    const thinkingId = `${Date.now()}-thinking`;
    const assistantId = `${Date.now()}-assistant`;
    setPrompt('');
    setError('');
    setMessages((current) => [...current, { id: userId, kind: 'user', text }, { id: thinkingId, kind: 'thinking', turnId: assistantId, text: '', status: 'streaming' }, { id: assistantId, kind: 'assistant', turnId: assistantId, text: '' }]);
    setPending(true);
    let streamedAnswer = '';
    let streamedThinking = '';
    try {
      const response = await fetch('/api/v1/agent/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify({ message: text, sessionId, debug: true }) });
      if (!response.ok) throw new Error('智能体网关返回错误');
      const data = await consumeAgentStream(response, (event) => {
        if (event.type === 'text_delta') {
          streamedAnswer += event.delta;
          setMessages((current) => current.map((item) => item.id === assistantId && item.kind === 'assistant' ? { ...item, text: streamedAnswer } : item));
        }
        if (event.type === 'thinking_delta') {
          streamedThinking += event.delta;
          setMessages((current) => current.map((item) => item.id === thinkingId && item.kind === 'thinking' ? { ...item, text: streamedThinking } : item));
        }
      });
      setMessages((current) => current.map((item) => {
        if (item.id === thinkingId && item.kind === 'thinking') return { ...item, status: 'complete', text: streamedThinking };
        if (item.id === assistantId && item.kind === 'assistant') return { ...item, text: data.answer, response: data };
        return item;
      }));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '智能体网关暂时不可用');
    } finally {
      setPending(false);
    }
  }

  return <div className={workspaceOpen ? 'workbench-shell' : 'workbench-shell workbench-shell-workspace-collapsed'}><main className="session-panel"><section className="conversation-stage"><div className="conversation-scroll">{messages.length === 0 ? <div className="welcome-state"><div className="welcome-mark"><span className="pi-welcome-glyph">π</span></div><h1>你好，我是 Pi</h1><p>从本地文件和知识库开始对话。Pi 会按需读取上下文，并在回答旁边保留依据。</p></div>: <div className="message-list">{messages.map((message) => message.kind === 'user' ? <UserMessage key={message.id} message={message} /> : message.kind === 'thinking' ? (showThinking ? <ThinkingMessage key={message.id} message={message} /> : null) : <AssistantMessage key={message.id} message={message} />)}</div>}</div><div className="composer-wrap"><div className="composer"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder="向项目提问…" rows={1} /><div className="composer-toolbar"><button type="button" className="composer-tool-button composer-tool-add" onClick={() => openWorkspace('files')} aria-label="添加项目上下文" title="打开项目文件"><Plus size={15} weight="bold" /></button><button type="button" className="composer-tool-button" onClick={() => openWorkspace('files')}><FolderOpen size={14} />项目文件</button><button type="button" className={showThinking ? 'composer-tool-button composer-tool-active' : 'composer-tool-button'} onClick={() => setShowThinking((visible) => !visible)} aria-pressed={showThinking}>思考</button><button type="button" className="composer-tool-button" onClick={() => openWorkspace('sessions')}><ChatCircle size={14} />会话</button><span className="composer-toolbar-spacer" /><div className="composer-more-wrap"><button type="button" className={modelMenuOpen ? 'composer-tool-button composer-tool-active' : 'composer-tool-button'} onClick={() => setModelMenuOpen((openState) => !openState)} aria-expanded={modelMenuOpen} aria-label="模型选择" title="选择模型" aria-haspopup="listbox"><span className="model-choice-label">{workspace.model.model ?? '本地降级'}</span><CaretDown size={12} /></button>{modelMenuOpen && <div className="composer-more-menu model-selection-menu" role="status"><strong>当前模型</strong><span>{workspace.model.model ?? '本地降级模式'}</span><small>{workspace.model.providerConfigured ? '已配置模型密钥' : '本地降级模式'}</small></div>}</div><button type="button" className="send-button" onClick={() => void send()} disabled={pending || !prompt.trim()} aria-label="发送"><ArrowUpRight size={18} weight="bold" /></button></div></div><div className="workspace-promo" aria-label="项目上下文提示"><span className="workspace-promo-mark">π</span><span className="workspace-promo-copy"><strong>从项目上下文开始</strong><small>文件、提示词和知识库会由 Pi 按需读取</small></span></div><div className="composer-foot"><span>按 Enter 发送 · Shift + Enter 换行</span><span><span className="composer-lock" />只读上下文</span></div></div></section></main><WorkspacePanel workspace={workspace} sessions={sessions} currentSessionId={sessionId} view={workspaceView} tree={fileTree} filter={resourceFilter} selectedResource={selectedResource} collapsedPaths={collapsedPaths} pending={pending} open={workspaceOpen} onToggleOpen={() => setWorkspaceOpen((openState) => !openState)} onViewChange={setWorkspaceView} onFilterChange={setResourceFilter} onToggle={togglePath} onSelect={setSelectedResource} onSelectSession={selectSession} onNewSession={resetSession} />{error && <div className="error-toast"><WarningCircle size={17} weight="fill" /><span>{error}</span><button onClick={() => setError('')}><X size={14} /></button></div>}</div>;
}

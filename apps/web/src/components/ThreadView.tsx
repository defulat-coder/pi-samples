import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/icons/ArrowsClockwise';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { Robot } from '@phosphor-icons/react/dist/icons/Robot';
import { Wrench } from '@phosphor-icons/react/dist/icons/Wrench';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../lib/types.js';
import type { LiveToolCall } from '../lib/stream.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="thinking-block">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className={cx('thinking-dot', streaming && 'active')} aria-hidden="true" />
          {streaming ? '正在思考…' : `思考过程 · ${text.length} 字符`}
          <CaretRight size={12} className="caret" aria-hidden="true" />
        </summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}

/** args/result 是 API 侧截断过的 JSON 文本，解析失败就按纯文本展示。 */
function tryParseToolPayload(text?: string): Record<string, unknown> | undefined {
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function toolCardTitle(tool: LiveToolCall): string {
  const args = tryParseToolPayload(tool.args);
  if (tool.name === 'subagent') {
    const agent = typeof args?.agent === 'string' ? args.agent : undefined;
    if (args?.action && args.action !== 'run') return `子代理管理 · ${String(args.action)}`;
    return agent ? `委派给 ${agent}` : '子代理委派';
  }
  if (tool.name === 'bash' && typeof args?.command === 'string') return `bash · ${args.command}`;
  return tool.name;
}

function ToolCard({ tool }: { tool: LiveToolCall }) {
  const [open, setOpen] = useState(false);
  const status = !tool.done ? 'running' : tool.isError ? 'fail' : 'ok';
  return (
    <motion.details
      className="tool-card"
      open={open}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: MOTION_EASE }}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="tool-card-icon" aria-hidden="true">
          {tool.name === 'subagent' ? <Robot size={14} /> : <Wrench size={14} />}
        </span>
        <span className="tool-card-title">{toolCardTitle(tool)}</span>
        <span className="tool-card-status" aria-hidden="true">
          {status === 'running' && <ArrowsClockwise size={13} className="running" />}
          {status === 'ok' && <Check size={13} className="ok" weight="bold" />}
          {status === 'fail' && <WarningCircle size={13} className="fail" weight="fill" />}
        </span>
        <CaretRight size={12} className="caret" aria-hidden="true" />
      </summary>
      <div className="tool-card-body">
        {tool.args && (
          <>
            <p className="tool-card-label">参数</p>
            <pre>{tool.args}</pre>
          </>
        )}
        {tool.result && (
          <>
            <p className="tool-card-label">结果</p>
            <pre>{tool.result}</pre>
          </>
        )}
      </div>
    </motion.details>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <motion.div
        className="message-row user"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: MOTION_EASE }}
      >
        <div className="user-bubble">
          <p>{message.text}</p>
        </div>
      </motion.div>
    );
  }
  return (
    <motion.div
      className="message-row assistant"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: MOTION_EASE }}
    >
      <div className={cx('assistant-body', message.streaming && 'streaming')}>
        {message.thinking && <ThinkingBlock text={message.thinking} streaming={message.streaming} />}
        {message.tools?.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
        <div className="markdown">
          <Markdown remarkPlugins={[remarkGfm]}>{message.text || (message.streaming ? '　' : '')}</Markdown>
        </div>
        {message.streaming && message.retry && (
          <p className="message-retry" role="status">
            <ArrowsClockwise size={14} className="spinning" aria-hidden="true" />
            第 {message.retry.attempt}/{message.retry.maxAttempts} 次重试：{message.retry.errorMessage || '请求失败'}
          </p>
        )}
        {message.interrupted && (
          <p className="message-interrupted" role="status">
            <WarningCircle size={14} weight="fill" />
            回复已中断，可以重新提问
          </p>
        )}
        {message.error && (
          <div className="message-error-card" role="alert">
            <p className="message-error-card-title">
              <WarningCircle size={14} weight="fill" />
              本轮回复失败
            </p>
            <p className="message-error-card-detail">{message.error}</p>
          </div>
        )}
      </div>
    </motion.div>
  );
}

export type ThreadViewProps = {
  messages: ChatMessage[];
  /** 界面偏好「消息紧凑模式」：缩小消息纵向间距。 */
  compact?: boolean;
};

export function ThreadView({ messages, compact = false }: ThreadViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages]);

  return (
    <div className="thread-scroll" ref={scrollRef}>
      <div className={cx('thread-column', compact && 'compact')}>
        {messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))}
        {!messages.length && (
          <p className="thread-empty-note">输入第一条消息，开始这段对话。</p>
        )}
      </div>
    </div>
  );
}

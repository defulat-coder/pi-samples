import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { CaretRight } from '@phosphor-icons/react/dist/icons/CaretRight';
import { ArrowsClockwise } from '@phosphor-icons/react/dist/icons/ArrowsClockwise';
import { WarningCircle } from '@phosphor-icons/react/dist/icons/WarningCircle';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../lib/types.js';

const motionEase = [0.23, 1, 0.32, 1] as const;

function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="thinking-block">
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className={streaming ? 'thinking-dot active' : 'thinking-dot'} aria-hidden="true" />
          {streaming ? '正在思考…' : `思考过程 · ${text.length} 字符`}
          <CaretRight size={12} className="caret" aria-hidden="true" />
        </summary>
        <pre>{text}</pre>
      </details>
    </div>
  );
}

function MessageItem({ message }: { message: ChatMessage }) {
  if (message.role === 'user') {
    return (
      <motion.div
        className="message-row user"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: motionEase }}
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
      transition={{ duration: 0.2, ease: motionEase }}
    >
      <div className={message.streaming ? 'assistant-body streaming' : 'assistant-body'}>
        {message.thinking && <ThinkingBlock text={message.thinking} streaming={message.streaming} />}
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
      <div className={compact ? 'thread-column compact' : 'thread-column'}>
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

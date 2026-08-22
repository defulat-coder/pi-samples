import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceResponse } from '@pi-workbench/contracts';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUp } from '@phosphor-icons/react/dist/icons/ArrowUp';
import { CaretDown } from '@phosphor-icons/react/dist/icons/CaretDown';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { Cpu } from '@phosphor-icons/react/dist/icons/Cpu';
import { Terminal } from '@phosphor-icons/react/dist/icons/Terminal';
import { fetchPrompt } from '../lib/api.js';
import { cx } from '../lib/cx.js';
import { MOTION_EASE } from '../lib/motion.js';
import { filterPrompts, movePromptSelection, promptQueryFromInput } from '../lib/prompts.js';
import { useDismissable } from '../hooks/useDismissable.js';
import { useWorkspace } from '../context/WorkspaceContext.js';

type ModelCatalog = WorkspaceResponse['models'];

export type ComposerProps = {
  disabled: boolean;
  selectedModel: string | undefined;
  onSelectModel: (model: string | undefined) => void;
  onSend: (text: string) => void;
};

function ModelMenu({ models, selectedModel, onSelect, onClose }: {
  models: ModelCatalog;
  selectedModel: string | undefined;
  onSelect: (model: string | undefined) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useDismissable(ref, onClose);

  const currentName = models.current.model ?? '默认';
  return (
    <motion.div
      ref={ref}
      className="model-menu"
      role="listbox"
      aria-label="选择模型"
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.15, ease: MOTION_EASE }}
    >
      <span className="model-menu-label">模型</span>
      <button
        type="button"
        role="option"
        aria-selected={selectedModel === undefined}
        className={cx('model-option', selectedModel === undefined && 'selected')}
        onClick={() => { onSelect(undefined); onClose(); }}
      >
        <span className="model-option-name">默认（{currentName}）</span>
        <Check size={14} weight="bold" />
      </button>
      {models.available.map((model) => (
        <button
          type="button"
          role="option"
          key={model.id}
          aria-selected={selectedModel === model.id}
          className={cx('model-option', selectedModel === model.id && 'selected')}
          onClick={() => { onSelect(model.id); onClose(); }}
        >
          <span className="model-option-name">{model.name}</span>
          <Check size={14} weight="bold" />
        </button>
      ))}
    </motion.div>
  );
}

export function Composer({ disabled, selectedModel, onSelectModel, onSend }: ComposerProps) {
  const { workspace } = useWorkspace();
  const prompts = workspace.prompts;
  const models = workspace.models;
  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [activePrompt, setActivePrompt] = useState(0);
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [loadingPrompt, setLoadingPrompt] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const promptQuery = promptQueryFromInput(text);
  const panelOpen = promptQuery !== null && !panelDismissed;
  const filtered = useMemo(() => (panelOpen ? filterPrompts(prompts, promptQuery) : []), [panelOpen, prompts, promptQuery]);

  useEffect(() => { setActivePrompt(0); }, [promptQuery]);

  const modelLabel = selectedModel
    ? models.available.find((model) => model.id === selectedModel)?.name ?? selectedModel
    : models.current.model ?? '默认';

  const applyPrompt = async (name: string) => {
    setLoadingPrompt(true);
    try {
      const document = await fetchPrompt(name);
      setText(document.content.trim());
      textareaRef.current?.focus();
    } catch (error) {
      // 拉取失败不清空用户已输入的内容；Composer 没有 notify 通道，先打日志保留现场。
      console.error('提示词暂时无法读取', error);
    } finally {
      setLoadingPrompt(false);
    }
  };

  const send = () => {
    const value = text.trim();
    if (!value || disabled || loadingPrompt) return;
    onSend(value);
    setText('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (panelOpen && filtered.length) {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActivePrompt((index) => movePromptSelection(index, 1, filtered.length)); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setActivePrompt((index) => movePromptSelection(index, -1, filtered.length)); return; }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const target = filtered[activePrompt] ?? filtered[0];
        if (target) void applyPrompt(target.name);
        return;
      }
    }
    if (event.key === 'Escape' && panelOpen) {
      event.preventDefault();
      setPanelDismissed(true);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      <motion.div
        className="prompt-panel"
        initial={false}
        animate={{ opacity: panelOpen ? 1 : 0, height: panelOpen ? 'auto' : 0 }}
        transition={{ duration: 0.2, ease: MOTION_EASE }}
        style={{ overflow: 'hidden', pointerEvents: panelOpen ? 'auto' : 'none', borderBottomWidth: panelOpen ? 1 : 0 }}
        inert={!panelOpen}
        aria-hidden={!panelOpen}
      >
        <p className="prompt-panel-label">提示词</p>
        <div className="prompt-panel-list" role="listbox" aria-label="提示词列表">
          {filtered.map((prompt, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === activePrompt}
              key={prompt.name}
              className={cx('prompt-row', index === activePrompt && 'active')}
              onMouseEnter={() => setActivePrompt(index)}
              onClick={() => void applyPrompt(prompt.name)}
            >
              <Terminal size={16} />
              <span className="prompt-row-copy">
                <span className="prompt-row-name">/{prompt.name}</span>
                {prompt.description && <span className="prompt-row-desc">{prompt.description}</span>}
              </span>
            </button>
          ))}
          {!filtered.length && <p className="prompt-panel-empty">没有匹配的提示词</p>}
        </div>
      </motion.div>

      <textarea
        ref={textareaRef}
        value={text}
        onChange={(event) => { setText(event.target.value); setPanelDismissed(false); }}
        onKeyDown={onKeyDown}
        placeholder="输入消息，或输入 / 使用提示词…"
        aria-label="消息输入框"
        rows={2}
      />

      <div className="composer-toolbar">
        <div className="composer-toolbar-left">
          <div className="model-menu-wrap">
            <button
              type="button"
              className="model-button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              aria-label="选择模型"
            >
              <Cpu size={16} />
              <span className="model-name">{modelLabel}</span>
              <CaretDown size={14} className="chevron" />
            </button>
            <AnimatePresence>
              {menuOpen && (
                <ModelMenu
                  models={models}
                  selectedModel={selectedModel}
                  onSelect={onSelectModel}
                  onClose={() => setMenuOpen(false)}
                />
              )}
            </AnimatePresence>
          </div>
        </div>
        <button
          type="button"
          className="send-button"
          onClick={send}
          disabled={!text.trim() || disabled || loadingPrompt || panelOpen}
          aria-label="发送消息"
        >
          <ArrowUp size={16} weight="bold" />
        </button>
      </div>
    </div>
  );
}

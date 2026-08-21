import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSummary, SessionSummary } from '@pi-workbench/contracts';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import {
  buildPaletteItems,
  filterPaletteItems,
  PALETTE_GROUP_LABELS,
  PALETTE_GROUP_ORDER,
  type PaletteAction,
  type PaletteGroup,
  type PaletteItem,
} from '../lib/palette.js';

export type CommandPaletteProps = {
  open: boolean;
  agents: AgentSummary[];
  sessionsByAgent: Record<string, SessionSummary[]>;
  onAction: (action: PaletteAction) => void;
  onClose: () => void;
};

/** ⌘K 命令面板（Fleet Search 的真实行为）：跨页面 / Agent / 会话过滤跳转，↑↓ 选择、Enter 执行、Esc 关闭。 */
export function CommandPalette({ open, agents, sessionsByAgent, onAction, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => buildPaletteItems({ agents, sessionsByAgent }), [agents, sessionsByAgent]);
  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  if (!open) return null;

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onAction(item.action);
    onClose();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(filtered[activeIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  let flatIndex = -1;
  const groups = PALETTE_GROUP_ORDER
    .map((group) => ({ group, items: filtered.filter((item) => item.group === group) }))
    .filter((entry) => entry.items.length > 0);

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="搜索与跳转" onClick={(event) => event.stopPropagation()}>
        <div className="palette-input-row">
          <MagnifyingGlass size={14} />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面、Agent、会话…"
            aria-label="搜索页面、Agent、会话"
          />
          <span className="search-kbd-group" aria-hidden="true"><kbd>esc</kbd></span>
        </div>
        <div className="palette-list" ref={listRef} role="listbox">
          {groups.map(({ group, items: groupItems }) => (
            <div key={group}>
              <p className="palette-group-label">{PALETTE_GROUP_LABELS[group as PaletteGroup]}</p>
              {groupItems.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                const active = index === activeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    data-active={active}
                    className={active ? 'palette-row active' : 'palette-row'}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => run(item)}
                  >
                    <span className="palette-row-label">{item.label}</span>
                    {item.hint && <span className="palette-row-hint">{item.hint}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {!filtered.length && <p className="palette-empty">没有匹配的结果</p>}
        </div>
      </div>
    </div>
  );
}

import { useEffect } from 'react';
import { X } from '@phosphor-icons/react/dist/icons/X';

const SHORTCUTS: Array<{ keys: string[]; description: string }> = [
  { keys: ['⌘', 'K'], description: '打开搜索与命令面板' },
  { keys: ['⌘', 'B'], description: '收起 / 展开侧边栏' },
  { keys: ['/'], description: '在空输入框中打开提示词面板' },
  { keys: ['Enter'], description: '发送消息' },
  { keys: ['Shift', 'Enter'], description: '消息内换行' },
  { keys: ['Esc'], description: '关闭面板 / 弹窗' },
];

/** Fleet 的 Keyboard Shortcuts 面板：列出本应用真实可用的快捷键。 */
export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card shortcuts-card" role="dialog" aria-label="键盘快捷键" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <strong>键盘快捷键</strong>
          <button type="button" className="icon-button" onClick={onClose} aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <div className="shortcuts-list">
          {SHORTCUTS.map((shortcut) => (
            <div className="shortcut-row" key={shortcut.description}>
              <span>{shortcut.description}</span>
              <span className="search-kbd-group">
                {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

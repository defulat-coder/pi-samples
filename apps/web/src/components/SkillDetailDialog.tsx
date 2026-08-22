import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { DownloadSimple } from '@phosphor-icons/react/dist/icons/DownloadSimple';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { Trash } from '@phosphor-icons/react/dist/icons/Trash';
import { X } from '@phosphor-icons/react/dist/icons/X';
import type { InstalledSkillContent, InstalledSkillSummary, LibrarySkillDetail, LibrarySkillSummary } from '@pi-workbench/contracts';
import { fetchInstalledSkillContent, fetchLibrarySkillDetail } from '../lib/api.js';
import { formatInstallCount } from '../lib/explore.js';
import { MOTION_EASE } from '../lib/motion.js';

/** 详情弹窗的目标：已安装卡片或技能库卡片。 */
export type SkillDetailTarget =
  | { kind: 'installed'; item: InstalledSkillSummary }
  | { kind: 'library'; item: LibrarySkillSummary };

export type SkillDetailDialogProps = {
  target: SkillDetailTarget;
  /** 正在进行安装/删除的技能标识；非 null 时禁用全部操作。 */
  busy: string | null;
  onClose: () => void;
  /** 库技能：点安装（成功后由父组件关闭弹窗并刷新列表）。 */
  onInstall: (item: LibrarySkillSummary) => void;
  /** 已安装技能：点删除（父组件关弹窗并弹确认）。 */
  onRemove: (item: InstalledSkillSummary) => void;
};

/**
 * 技能详情弹窗（§11.6 卡片点击）：已安装技能拉取完整 SKILL.md 用项目现有
 * react-markdown 渲染；库技能拉取 skills.sh 详情（og:description）。Esc/点 backdrop 关闭。
 */
export function SkillDetailDialog({ target, busy, onClose, onInstall, onRemove }: SkillDetailDialogProps) {
  const [content, setContent] = useState<InstalledSkillContent | null>(null);
  const [detail, setDetail] = useState<LibrarySkillDetail | null>(null);
  const [error, setError] = useState('');

  const installed = target.kind === 'installed' ? target.item : null;
  const libraryItem = target.kind === 'library' ? target.item : null;

  useEffect(() => {
    let cancelled = false;
    setError('');
    if (target.kind === 'installed') {
      fetchInstalledSkillContent(target.item.scope, target.item.name)
        .then((result) => { if (!cancelled) setContent(result); })
        .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '技能内容暂时无法读取'); });
    } else {
      const skillId = target.item.id.split('/').pop() ?? target.item.name;
      fetchLibrarySkillDetail(target.item.source, skillId)
        .then((result) => { if (!cancelled) setDetail(result); })
        .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : '技能详情暂时无法读取'); });
    }
    return () => { cancelled = true; };
    // target 身份在弹窗生命周期内固定（父组件按条目 path/id 作 key）。
  }, [target]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const name = installed?.name ?? libraryItem?.name ?? '';
  const loading = !error && (installed ? content === null : detail === null);

  return (
    <motion.div
      className="modal-backdrop"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={() => { if (!busy) onClose(); }}
    >
      <motion.div
        className="skill-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`技能详情 ${name}`}
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.2, ease: MOTION_EASE }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="skill-dialog-head">
          <PuzzlePiece size={16} aria-hidden="true" />
          <span className="skill-dialog-title">
            <strong>{name}</strong>
            <small>{installed ? installed.path : libraryItem?.id}</small>
          </span>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose} disabled={busy !== null}>
            <X size={14} />
          </button>
        </div>

        <div className="skill-dialog-body">
          <span className="skill-dialog-badges">
            {installed && <span className="skill-badge">{installed.scope === 'agents' ? '.agents/skills' : '.pi/skills'}</span>}
            {(installed?.source ?? libraryItem?.source) && <span className="skill-badge">{installed?.source ?? libraryItem?.source}</span>}
            {libraryItem?.rank !== undefined && <span className="skill-badge">#{libraryItem.rank}</span>}
            {(libraryItem?.installs ?? 0) > 0 && <span className="skill-badge">{formatInstallCount(libraryItem!.installs)} 次安装</span>}
          </span>

          {loading && (
            <p className="skill-dialog-loading">
              <CircleNotch size={14} className="spinning" />
              正在读取详情…
            </p>
          )}
          {error && <p className="modal-error" role="alert">{error}</p>}

          {content && (
            <>
              {content.description && <p className="skill-dialog-desc">{content.description}</p>}
              <div className="markdown">
                <Markdown remarkPlugins={[remarkGfm]}>{content.content}</Markdown>
              </div>
            </>
          )}
          {detail && (
            <>
              {detail.installs !== undefined && <p className="skill-dialog-desc">{formatInstallCount(detail.installs)} 次安装 · {detail.source}</p>}
              <p className="skill-dialog-desc">{detail.description ?? '（skills.sh 未提供描述）'}</p>
            </>
          )}
        </div>

        <div className="skill-dialog-actions">
          {installed && installed.scope === 'agents' && (
            <button type="button" className="header-button danger" disabled={busy !== null} onClick={() => onRemove(installed)}>
              <Trash size={13} />
              删除
            </button>
          )}
          {libraryItem && (
            libraryItem.installed ? (
              <button type="button" className="header-button" disabled>
                <Check size={12} />
                已安装
              </button>
            ) : (
              <button type="button" className="header-button primary" disabled={busy !== null} onClick={() => onInstall(libraryItem)}>
                {busy === libraryItem.id ? <CircleNotch size={12} className="spinning" /> : <DownloadSimple size={12} />}
                安装
              </button>
            )
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

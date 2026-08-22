import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check } from '@phosphor-icons/react/dist/icons/Check';
import { CircleNotch } from '@phosphor-icons/react/dist/icons/CircleNotch';
import { FileText } from '@phosphor-icons/react/dist/icons/FileText';
import { GithubLogo } from '@phosphor-icons/react/dist/icons/GithubLogo';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { User } from '@phosphor-icons/react/dist/icons/User';
import { X } from '@phosphor-icons/react/dist/icons/X';
import type { InstalledSkillSummary, LibrarySkillSummary } from '@pi-workbench/contracts';
import { fetchInstalledSkills, fetchSkillLibrary, installSkill, removeSkill } from '../lib/api.js';
import { formatInstallCount } from '../lib/explore.js';
import { cx } from '../lib/cx.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { MOTION_EASE } from '../lib/motion.js';
import { useWorkspace } from '../context/WorkspaceContext.js';
import { SkillDetailDialog, type SkillDetailTarget } from './SkillDetailDialog.js';

type SkillsTab = 'installed' | 'library';

const TABS: Array<{ key: SkillsTab; label: string }> = [
  { key: 'installed', label: '已安装' },
  { key: 'library', label: '技能库' },
];

/**
 * Skills 页（§11.6，Fleet 16-skills.json 实测）两个 tab：
 * - 已安装：.pi/prompts 提示词模板 + 本地已安装技能（.agents/skills / .pi/skills）。
 * - 技能库：skills.sh 榜单与搜索（≥2 字符，300ms 防抖）。
 * 卡片即 button，点击打开详情弹窗；安装/删除操作收进弹窗。
 */
export function SkillsView() {
  const { workspace } = useWorkspace();
  const prompts = workspace.prompts;
  const [tab, setTab] = useState<SkillsTab>('installed');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetailTarget | null>(null);
  const [pendingRemove, setPendingRemove] = useState<InstalledSkillSummary | null>(null);

  const installed = useAsyncData(fetchInstalledSkills, { onError: (cause) => setActionError(cause.message) });
  const { reload: reloadInstalled } = installed;
  useEffect(() => { void reloadInstalled(); }, [reloadInstalled]);

  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setAppliedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const [libraryError, setLibraryError] = useState('');
  const library = useAsyncData(() => fetchSkillLibrary(appliedQuery), { onError: (cause) => setLibraryError(cause.message) });
  const { reload: reloadLibrary } = library;
  useEffect(() => {
    setLibraryError('');
    void reloadLibrary();
  }, [reloadLibrary, appliedQuery]);

  /** 安装/删除成功后：响应即最新已安装列表；再刷新技能库让 installed 标记跟上。 */
  const applyInstalled = (result: typeof installed.data) => {
    installed.setData(result);
    void reloadLibrary();
  };

  const install = async (item: LibrarySkillSummary) => {
    if (busy || item.installed) return;
    setBusy(item.id);
    setActionError('');
    try {
      const skillId = item.id.split('/').pop() ?? item.name;
      applyInstalled(await installSkill({ source: item.source, skillId }));
      setDetail(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '技能暂时无法安装');
    } finally {
      setBusy(null);
    }
  };

  const confirmRemove = async () => {
    if (!pendingRemove || busy) return;
    setBusy(pendingRemove.name);
    setActionError('');
    try {
      applyInstalled(await removeSkill({ name: pendingRemove.name }));
      setPendingRemove(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '技能暂时无法删除');
    } finally {
      setBusy(null);
    }
  };

  const installedItems = installed.data?.items ?? [];
  const libraryItems = library.data?.items ?? [];

  return (
    <div className="explore">
      <header className="explore-header compact">
        <h3>Skills</h3>
        <p>本地已安装的技能与提示词模板，以及 skills.sh 技能库。</p>
      </header>

      <div className="session-tabs explore-tabs" role="tablist" aria-label="技能视图">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={cx('session-tab', tab === key && 'active')}
            onClick={() => setTab(key)}
          >
            {label}
            {key === 'installed' && installedItems.length > 0 && <span className="session-tab-count">{installedItems.length}</span>}
          </button>
        ))}
      </div>

      {actionError && <p className="modal-error" role="alert">{actionError}</p>}

      {tab === 'installed' && (
        <>
          <p className="explore-section-label">提示词模板</p>
          {prompts.length ? (
            <div className="skills-grid" role="list">
              {prompts.map((prompt, index) => (
                <motion.div
                  role="listitem"
                  key={prompt.path}
                  className="skill-card static"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: MOTION_EASE, delay: Math.min(index, 10) * 0.03 }}
                >
                  <span className="skill-card-head">
                    <FileText size={16} aria-hidden="true" />
                    <strong>{prompt.name}</strong>
                  </span>
                  <span className="skill-card-desc">{prompt.description ?? ''}</span>
                  <span className="skill-card-meta">
                    <FileText size={12} aria-hidden="true" />
                    <span className="grow skill-card-path">{prompt.path}</span>
                  </span>
                </motion.div>
              ))}
            </div>
          ) : (
            <p className="explore-hint">暂无提示词模板</p>
          )}

          <p className="explore-section-label">技能</p>
          {!installed.loaded ? (
            <p className="explore-hint">正在读取已安装技能…</p>
          ) : installedItems.length ? (
            <div className="skills-grid" role="list">
              {installedItems.map((item, index) => (
                <motion.div
                  role="listitem"
                  key={item.path}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: MOTION_EASE, delay: Math.min(index, 10) * 0.03 }}
                >
                  <button type="button" className="skill-card" onClick={() => setDetail({ kind: 'installed', item })}>
                    <span className="skill-card-head">
                      <PuzzlePiece size={16} aria-hidden="true" />
                      <strong>{item.name}</strong>
                      <span className="skill-card-scope">{item.scope === 'agents' ? '.agents' : '.pi'}</span>
                    </span>
                    <span className="skill-card-desc">{item.description ?? item.preview ?? '（无描述）'}</span>
                    <span className="skill-card-meta">
                      {item.source ? <GithubLogo size={12} aria-hidden="true" /> : <User size={12} aria-hidden="true" />}
                      <span className="grow skill-card-path">{item.source ?? item.path}</span>
                    </span>
                  </button>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="explore-empty">
              <PuzzlePiece size={24} aria-hidden="true" />
              <p className="explore-empty-title">暂无已安装技能</p>
              <p className="explore-empty-hint">到技能库搜索并安装，或把 SKILL.md 放进 .pi/skills/。</p>
              <button type="button" className="header-button primary" onClick={() => setTab('library')}>
                去技能库逛逛
              </button>
            </div>
          )}
        </>
      )}

      {tab === 'library' && (
        <>
          <div className="explore-toolbar">
            <label className="explore-search">
              <MagnifyingGlass size={12} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 skills.sh 技能库…" aria-label="搜索技能库" />
            </label>
            <span className="explore-hint">{appliedQuery.length >= 2 ? `搜索「${appliedQuery}」` : 'skills.sh 热门榜单'}</span>
          </div>

          {libraryError && library.data === null ? (
            <div className="explore-empty">
              <PuzzlePiece size={24} aria-hidden="true" />
              <p className="explore-empty-title">技能库暂时不可用</p>
              <p className="explore-empty-hint">{libraryError}</p>
            </div>
          ) : libraryItems.length ? (
            <div className="skills-grid" role="list">
              {libraryItems.map((item, index) => (
                <motion.div
                  role="listitem"
                  key={item.id}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, ease: MOTION_EASE, delay: Math.min(index, 10) * 0.03 }}
                >
                  <button type="button" className="skill-card" onClick={() => setDetail({ kind: 'library', item })}>
                    <span className="skill-card-head">
                      {item.rank !== undefined && <span className="skill-card-rank">#{item.rank}</span>}
                      <strong>{item.name}</strong>
                      {item.installed && (
                        <span className="skill-card-installed">
                          <Check size={12} aria-hidden="true" />
                          已安装
                        </span>
                      )}
                    </span>
                    <span className="skill-card-desc">{item.description ?? ''}</span>
                    <span className="skill-card-meta">
                      <GithubLogo size={12} aria-hidden="true" />
                      <span className="grow skill-card-path">{item.source}</span>
                      <span className="skill-card-installs">{formatInstallCount(item.installs)} 次安装</span>
                    </span>
                  </button>
                </motion.div>
              ))}
            </div>
          ) : (
            <p className="explore-hint">{library.loading ? '正在读取技能库…' : appliedQuery.length >= 2 ? `没有匹配「${appliedQuery}」的技能` : '榜单暂无数据'}</p>
          )}
        </>
      )}

      <AnimatePresence>
        {detail && (
          <SkillDetailDialog
            key={detail.kind === 'installed' ? detail.item.path : detail.item.id}
            target={detail}
            busy={busy}
            onClose={() => setDetail(null)}
            onInstall={(item) => void install(item)}
            onRemove={(item) => { setDetail(null); setPendingRemove(item); }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pendingRemove && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => { if (!busy) setPendingRemove(null); }}
          >
            <motion.div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-label={`删除技能 ${pendingRemove.name}`}
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
              onClick={(event) => event.stopPropagation()}
            >
              <div className="modal-head">
                <strong>删除技能：{pendingRemove.name}</strong>
                <button type="button" className="icon-button" aria-label="关闭" onClick={() => setPendingRemove(null)} disabled={busy !== null}>
                  <X size={14} />
                </button>
              </div>
              <p className="modal-hint">
                将从 <code>{pendingRemove.path}</code> 移除该技能（skills remove）。此操作不可撤销。
              </p>
              <div className="modal-actions">
                <button type="button" className="header-button" onClick={() => setPendingRemove(null)} disabled={busy !== null}>取消</button>
                <button type="button" className="header-button danger" onClick={() => void confirmRemove()} disabled={busy !== null}>
                  {busy === pendingRemove.name ? <CircleNotch size={13} className="spinning" /> : null}
                  删除
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import type { PromptSummary } from '@pi-workbench/contracts';
import { FileText } from '@phosphor-icons/react/dist/icons/FileText';
import { MagnifyingGlass } from '@phosphor-icons/react/dist/icons/MagnifyingGlass';
import { PuzzlePiece } from '@phosphor-icons/react/dist/icons/PuzzlePiece';
import { fetchSkills } from '../lib/api.js';
import { filterSkillItems, mergeSkillItems } from '../lib/explore.js';
import { useAsyncData } from '../hooks/useAsyncData.js';
import { MOTION_EASE } from '../lib/motion.js';

export type SkillsViewProps = {
  /** 提示词模板（.pi/prompts/*.md），来自工作区快照。 */
  prompts: PromptSummary[];
};

/** Skills 页（§11.6）：.pi/skills 技能 + .pi/prompts 提示词模板；技能目录为空时给空态。 */
export function SkillsView({ prompts }: SkillsViewProps) {
  const skills = useAsyncData(fetchSkills);
  const [query, setQuery] = useState('');

  useEffect(() => { void skills.reload(); }, [skills.reload]);

  const loading = !skills.loaded;
  const items = useMemo(() => filterSkillItems(mergeSkillItems(prompts, skills.data ?? []), query), [prompts, skills.data, query]);
  const skillItems = items.filter((item) => item.kind === 'skill');
  const promptItems = items.filter((item) => item.kind === 'prompt');

  return (
    <div className="explore">
      <header className="explore-header compact">
        <h3>Skills</h3>
        <p>本项目的技能（.pi/skills）与提示词模板（.pi/prompts）。</p>
      </header>

      <div className="explore-toolbar">
        <label className="explore-search">
          <MagnifyingGlass size={12} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索技能与提示词…" aria-label="搜索技能与提示词" />
        </label>
      </div>

      <p className="explore-section-label">技能</p>
      {loading ? (
        <p className="explore-hint">正在读取 .pi/skills…</p>
      ) : skillItems.length ? (
        <div className="skills-grid" role="list">
          {skillItems.map((item, index) => (
            <motion.div
              role="listitem"
              key={item.path}
              className="skill-card"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: MOTION_EASE, delay: index * 0.03 }}
            >
              <span className="skill-card-head">
                <PuzzlePiece size={16} aria-hidden="true" />
                <strong>{item.name}</strong>
              </span>
              <span className="skill-card-desc">{item.description ?? item.preview ?? '（无描述）'}</span>
              <span className="skill-card-path">{item.path}</span>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="explore-empty">
          <PuzzlePiece size={24} aria-hidden="true" />
          <p className="explore-empty-title">暂无技能</p>
          <p className="explore-empty-hint">在 .pi/skills/&lt;名称&gt;/SKILL.md 下添加技能后会显示在这里。</p>
        </div>
      )}

      <p className="explore-section-label">提示词模板</p>
      {promptItems.length ? (
        <div className="skills-grid" role="list">
          {promptItems.map((item, index) => (
            <motion.div
              role="listitem"
              key={item.path}
              className="skill-card"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, ease: MOTION_EASE, delay: index * 0.03 }}
            >
              <span className="skill-card-head">
                <FileText size={16} aria-hidden="true" />
                <strong>{item.name}</strong>
              </span>
              <span className="skill-card-desc">{item.description ?? ''}</span>
              {item.preview && <span className="skill-card-preview">{item.preview}</span>}
              <span className="skill-card-path">{item.path}</span>
            </motion.div>
          ))}
        </div>
      ) : (
        <p className="explore-hint">{query ? '没有匹配的提示词模板' : '暂无提示词模板'}</p>
      )}
    </div>
  );
}

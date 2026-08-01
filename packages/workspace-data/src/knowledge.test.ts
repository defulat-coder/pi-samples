import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeKnowledgeIndexes, loadKnowledgeBundle, searchKnowledge } from './knowledge.js';

const temporaryRoots: string[] = [];

function createKnowledgeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-knowledge-'));
  temporaryRoots.push(root);
  return root;
}

function writeConcept(root: string, name: string, content: string): void {
  const path = join(root, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  closeKnowledgeIndexes();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('OKF Markdown knowledge index', () => {
  it('parses YAML frontmatter and searches Chinese and English content', () => {
    const root = createKnowledgeRoot();
    writeConcept(root, 'agent/session.md', `---
type: concept
title: Session 生命周期
description: Pi 会话从创建到结束的状态变化。
tags: [Pi, Agent, 知识库]
status: active
updated: 2026-08-02
---

# Session 生命周期

本文说明 session 的创建、turn 提交、事件流和关闭过程。
`);
    writeConcept(root, 'draft.md', `---
title: Draft
tags: [draft]
status: draft
---

Draft content is not searchable while it is not active.
`);

    const concepts = loadKnowledgeBundle(root, { indexPath: ':memory:' });
    assert.equal(concepts.length, 2);
    assert.deepEqual(concepts.find((concept) => concept.id === 'agent/session')?.tags, ['Pi', 'Agent', '知识库']);
    assert.equal(concepts.find((concept) => concept.id === 'agent/session')?.status, 'active');

    const chinese = searchKnowledge('知识库 生命周期', { root, indexPath: ':memory:', limit: 5 });
    assert.equal(chinese.length, 1);
    assert.equal(chinese[0]?.title, 'Session 生命周期');
    assert.ok(chinese[0]?.fields?.some((field) => field.startsWith('章节：')));
    assert.match(chinese[0]?.excerpt ?? '', /生命周期/);
  });

  it('keeps title matches ahead of body-only matches with BM25 weighting', () => {
    const root = createKnowledgeRoot();
    writeConcept(root, 'title-match.md', `---
title: Pi session 设计
description: A short design note.
tags: [pi]
status: active
---

本文介绍会话设计。
`);
    writeConcept(root, 'body-match.md', `---
title: 运行时说明
description: A runtime note.
tags: [runtime]
status: active
---

本文在正文中多次讨论 Pi session 的生命周期和 turn 事件。
`);

    const results = searchKnowledge('session', { root, indexPath: ':memory:', limit: 5 });
    assert.equal(results.length, 2);
    assert.equal(results[0]?.title, 'Pi session 设计');
  });

  it('incrementally updates changed files and removes deleted files', () => {
    const root = createKnowledgeRoot();
    writeConcept(root, 'mutable.md', `---
title: Old concept
description: old description
status: active
---

oldlegacy retrieval phrase
    `);
    const indexPath = join(root, 'index.sqlite');
    const indexOptions = { root, indexPath, refreshIntervalMs: 0 };

    assert.equal(searchKnowledge('oldlegacy', indexOptions).length, 1);
    writeConcept(root, 'mutable.md', `---
title: New concept
description: new description
status: active
---

newlegacy retrieval phrase
`);
    assert.equal(searchKnowledge('newlegacy', indexOptions)[0]?.title, 'New concept');
    assert.equal(searchKnowledge('oldlegacy', indexOptions).length, 0);

    writeConcept(root, 'removed.md', `---
title: Removed concept
status: active
---

remove me
`);
    assert.equal(searchKnowledge('remove me', indexOptions).length, 1);
    rmSync(join(root, 'removed.md'));
    assert.equal(searchKnowledge('remove me', indexOptions).length, 0);
  });

  it('returns no results for empty or operator-shaped input without throwing', () => {
    const root = createKnowledgeRoot();
    writeConcept(root, 'safe.md', `---
title: Safe search
status: active
---

safe content
`);
    const options = { root, indexPath: ':memory:' };
    assert.deepEqual(searchKnowledge('', options), []);
    assert.deepEqual(searchKnowledge('   *** OR NOT ( ) "', options), []);
  });
});

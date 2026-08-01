export * from './knowledge.js';
export * from './seed.js';
export * from './store.js';
export * from './sqlite-store.js';

import { SqliteWorkspaceStore } from './sqlite-store.js';
import { memoryStore } from './store.js';

export const workspaceStore = process.env.PI_WORKSPACE_DB_MODE === 'memory' ? memoryStore : new SqliteWorkspaceStore();

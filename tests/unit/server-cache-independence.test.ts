import { describe, expect, spyOn, test } from 'bun:test';
import { CopilotMoneyServer } from '../../src/server.js';
import { CopilotDatabase } from '../../src/core/database.js';
import { CopilotMoneyTools } from '../../src/tools/tools.js';
import type { GraphQLClient } from '../../src/core/graphql/client.js';
import { ALL_TOOL_DEFS } from '../../src/tools/registry/index.js';

describe('live mode without local cache access', () => {
  test('server construction and tool discovery never inspect the protected app container', () => {
    // Isolate the filesystem mock so other tests retain their real filesystem.
    const script = `
      import { mock } from 'bun:test';
      const fs = await import('node:fs');
      const existsSync = fs.existsSync;
      mock.module('fs', () => ({
        ...fs,
        existsSync(path) {
          if (String(path).includes('com.copilot.production')) {
            throw new Error('Protected app container accessed before a cache request');
          }
          return existsSync(path);
        },
      }));
      const { CopilotMoneyServer } = await import(${JSON.stringify(new URL('../../src/server.ts', import.meta.url).href)});
      const server = new CopilotMoneyServer(undefined, undefined, true, true, {});
      if (!server.handleListTools().tools.some(t => t.name === 'get_accounts_live')) {
        throw new Error('Live tools missing');
      }
    `;
    const result = Bun.spawnSync([process.execPath, '-e', script]);
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });

  for (const def of ALL_TOOL_DEFS.filter((tool) => tool.requiresLiveReads || !tool.readOnly)) {
    test(`${def.name} dispatches without checking the local cache`, async () => {
      const server = new CopilotMoneyServer(
        '/nonexistent/cache',
        undefined,
        true,
        true,
        {} as GraphQLClient
      );
      const db = new CopilotDatabase('/nonexistent/cache');
      db.isAvailable = () => {
        throw new Error('Local cache must not gate API tools');
      };
      server._injectForTesting(db, new CopilotMoneyTools(db));
      const handler = spyOn(def, 'handler').mockResolvedValue({ dispatched: true });
      try {
        const result = await server.handleCallTool(def.name, {});
        expect(result.isError).not.toBe(true);
        expect(handler).toHaveBeenCalledTimes(1);
        expect(result.content).toEqual([
          { type: 'text', text: JSON.stringify({ dispatched: true }, null, 2) },
        ]);
      } finally {
        handler.mockRestore();
      }
    });
  }

  test('cache-only tools still report an unavailable cache', async () => {
    const server = new CopilotMoneyServer(
      '/nonexistent/cache',
      undefined,
      false,
      true,
      {} as GraphQLClient
    );
    const result = await server.handleCallTool('get_goals', {});
    expect(JSON.stringify(result.content)).toContain('Database not available');
  });
});

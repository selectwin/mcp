import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MCP_VERSION, configFromEnv } from '../src/config';

describe('MCP_VERSION', () => {
  it('matches package.json (single source of truth — guards against drift)', () => {
    const { version } = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(MCP_VERSION).toBe(version);
  });

  it('is carried into the User-Agent', () => {
    expect(configFromEnv().userAgent).toBe(`selectwin-mcp/${MCP_VERSION}`);
  });
});

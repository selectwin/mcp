#!/usr/bin/env node
/**
 * stdio host for the Selectwin MCP server — for local clients (Claude Desktop,
 * Cursor, Claude Code). The SelectKey comes from SELECTWIN_API_KEY.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configFromEnv } from './config.js';
import { createServer } from './server.js';

const server = createServer(configFromEnv());
const transport = new StdioServerTransport();
await server.connect(transport);

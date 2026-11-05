#!/usr/bin/env node
/**
 * stdio host for the Selectwin MCP server — for local clients (Claude Desktop, Cursor, Claude Code). The SelectKey comes
 * from SELECTWIN_API_KEY. `serveStdio` (SDK v2) serves both eras on one connection: a 2025 client's `initialize`, or a
 * 2026-07-28 client's `server/discover` + per-request envelope.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { configFromEnv } from './config.js';
import { createServer } from './server.js';

serveStdio(() => createServer(configFromEnv()));

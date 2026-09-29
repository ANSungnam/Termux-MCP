#!/usr/bin/env node
import { main } from '../src/index.js';
import { buildPath, homeDir, isTermux, termuxPrefix } from '../src/paths.js';

process.env.TERMUX_MCP_FORCE = '1';
process.env.PATH = buildPath();
if (isTermux && !process.env.PREFIX) process.env.PREFIX = termuxPrefix;
if (isTermux && !process.env.HOME) process.env.HOME = homeDir;

await main(process.argv.slice(2));

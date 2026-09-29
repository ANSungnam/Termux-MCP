import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { run } from '../exec.js';
import { assertPath, clampText } from '../policy.js';
import { describeError, errorResult, json, text } from '../result.js';

const pathSchema = z.string().describe('Absolute path, or a path relative to the allowed root.');

async function readLines(filePath, { offset, limit, maxBytes }) {
  const stats = await fs.promises.stat(filePath);
  const startLine = Math.max(1, offset ?? 1);
  const wanted = limit ?? Number.POSITIVE_INFINITY;
  const collected = [];
  let lineNumber = 0;
  let bytesRead = 0;
  let buffered = '';

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => {
      if (collected.length >= wanted || bytesRead >= maxBytes) {
        stream.destroy();
        return;
      }
      bytesRead += Buffer.byteLength(chunk, 'utf8');
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        lineNumber += 1;
        if (lineNumber >= startLine) collected.push(line);
        if (collected.length >= wanted || bytesRead >= maxBytes) {
          stream.destroy();
          return;
        }
        newline = buffered.indexOf('\n');
      }
    });
    stream.on('close', resolve);
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return {
    text: collected.join('\n'),
    lines: collected.length,
    bytesRead,
    size: stats.size,
    fromLine: startLine,
    partial: lineNumber > startLine + collected.length - 1,
  };
}

function describeEntry(stats) {
  return {
    size: stats.size,
    mode: (stats.mode & 0o7777).toString(8).padStart(4, '0'),
    uid: stats.uid,
    gid: stats.gid,
    modified: new Date(stats.mtimeMs).toISOString(),
    isDirectory: stats.isDirectory(),
    isFile: stats.isFile(),
    isSymbolicLink: stats.isSymbolicLink(),
  };
}

export function registerFsTools(register) {
  register(
    'fs_read',
    {
      title: 'Read a file',
      description:
        'Read a UTF-8 text file with line offset and limit, or read any file as base64 when encoding is base64.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathSchema,
        offset: z.number().int().min(1).optional().describe('First line to return (1-based).'),
        limit: z.number().int().min(1).max(100000).optional().describe('Maximum number of lines.'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('Defaults to utf8.'),
        max_bytes: z.number().int().min(1).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const target = assertPath(args.path, config);
        const maxBytes = Math.min(args.max_bytes ?? config.limits.maxReadBytes, config.limits.maxReadBytes);
        const stats = await fsp.stat(target);
        if (stats.isDirectory()) return errorResult(`${target} is a directory; use fs_list.`);

        if (args.encoding === 'base64') {
          const handle = await fsp.open(target, 'r');
          try {
            const length = Math.min(stats.size, maxBytes);
            const buffer = Buffer.alloc(length);
            await handle.read(buffer, 0, length, 0);
            return json({
              path: target,
              size: stats.size,
              bytesRead: length,
              truncated: stats.size > length,
              base64: buffer.toString('base64'),
            });
          } finally {
            await handle.close();
          }
        }

        const result = await readLines(target, { offset: args.offset, limit: args.limit, maxBytes });
        const clamped = clampText(result.text, maxBytes);
        return json({
          path: target,
          size: result.size,
          fromLine: result.fromLine,
          lines: result.lines,
          partial: result.partial,
          text: clamped.text,
          truncated: clamped.truncated,
        });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_write',
    {
      title: 'Write a file',
      description:
        'Create or overwrite a file. Provide content as text or base64. The audit log and config file are protected.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathSchema,
        content: z.string().describe('File content, or base64 when base64 is true.'),
        base64: z.boolean().optional().describe('Treat content as base64 encoded bytes.'),
        append: z.boolean().optional(),
        create_parents: z.boolean().optional().describe('Create missing parent directories.'),
        mode: z.number().int().min(0).max(0o777).optional().describe('Permission bits for a newly created file.'),
      }),
    },
    async (args, { config }) => {
      try {
        const target = assertPath(args.path, config, { write: true });
        const data = args.base64 ? Buffer.from(args.content, 'base64') : Buffer.from(args.content, 'utf8');
        if (args.create_parents) await fsp.mkdir(path.dirname(target), { recursive: true });
        const existed = fs.existsSync(target);
        if (args.append) await fsp.appendFile(target, data);
        else await fsp.writeFile(target, data, existed ? undefined : { mode: args.mode ?? 0o600 });
        const stats = await fsp.stat(target);
        return json({ path: target, bytesWritten: data.length, created: !existed, ...describeEntry(stats) });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_list',
    {
      title: 'List a directory',
      description: 'List directory entries with size, mode and modification time. Optionally recurse to a depth.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathSchema.optional(),
        recursive: z.boolean().optional(),
        depth: z.number().int().min(1).max(16).optional(),
        include_hidden: z.boolean().optional(),
        limit: z.number().int().min(1).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const root = assertPath(args.path, config);
        const maxDepth = args.depth ?? (args.recursive ? 2 : 1);
        const limit = args.limit ?? config.limits.maxListEntries;
        const entries = [];

        const walk = async (dir, level) => {
          if (entries.length >= limit || level > maxDepth) return;
          const dirents = await fsp.readdir(dir, { withFileTypes: true });
          for (const dirent of dirents) {
            if (entries.length >= limit) return;
            if (!args.include_hidden && dirent.name.startsWith('.')) continue;
            const full = path.join(dir, dirent.name);
            const relative = path.relative(root, full) || dirent.name;
            let stats = null;
            try {
              stats = await fsp.lstat(full);
            } catch {
              stats = null;
            }
            entries.push({
              name: dirent.name,
              path: relative,
              absolute: full,
              type: stats?.isSymbolicLink() ? 'symlink' : dirent.isDirectory() ? 'directory' : 'file',
              ...(stats ? { size: stats.size, mode: (stats.mode & 0o7777).toString(8), modified: new Date(stats.mtimeMs).toISOString() } : {}),
            });
            if (stats?.isDirectory() && level < maxDepth) await walk(full, level + 1);
          }
        };

        await walk(root, 1);
        return json({ root, count: entries.length, truncated: entries.length >= limit, entries });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_stat',
    {
      title: 'Stat a path',
      description: 'Return detailed metadata for a file or directory.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({ path: pathSchema }),
    },
    async (args, { config }) => {
      try {
        const target = assertPath(args.path, config);
        const stats = await fsp.lstat(target);
        return json({ path: target, ...describeEntry(stats), birthtime: new Date(stats.birthtimeMs).toISOString() });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_mkdir',
    {
      title: 'Create a directory',
      description: 'Create a directory, optionally with all missing parents.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathSchema,
        recursive: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const target = assertPath(args.path, config, { write: true });
        const existed = fs.existsSync(target);
        if (args.recursive === false) await fsp.mkdir(target);
        else await fsp.mkdir(target, { recursive: true });
        return json({ path: target, created: !existed });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_move',
    {
      title: 'Move or rename',
      description: 'Rename a path, or copy it across filesystems when a rename is not possible.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        from: pathSchema,
        to: pathSchema,
        overwrite: z.boolean().optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const from = assertPath(args.from, config, { write: true });
        const to = assertPath(args.to, config, { write: true });
        if (fs.existsSync(to) && args.overwrite !== true) {
          return errorResult(`refused: ${to} already exists. Pass overwrite: true to replace it.`);
        }
        if (fs.existsSync(to)) await fsp.rm(to, { recursive: true, force: true });
        try {
          await fsp.rename(from, to);
          return json({ from, to, method: 'rename' });
        } catch (error) {
          if (error.code !== 'EXDEV') throw error;
          await fsp.cp(from, to, { recursive: true });
          await fsp.rm(from, { recursive: true, force: true });
          return json({ from, to, method: 'copy' });
        }
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_delete',
    {
      title: 'Delete a path',
      description: 'Delete a file or directory tree. Requires confirm: true.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathSchema,
        recursive: z.boolean().optional(),
        confirm: z.boolean().optional().describe('Must be true. Deletions are never performed implicitly.'),
      }),
    },
    async (args, { config }) => {
      try {
        const target = assertPath(args.path, config, { write: true });
        if (args.confirm !== true) {
          return errorResult(
            `refused: deleting ${target} is destructive. Re-run with confirm: true.`,
          );
        }
        if (!fs.existsSync(target)) return errorResult(`${target} does not exist.`);
        const stats = await fsp.lstat(target);
        if (stats.isDirectory() && args.recursive !== true) {
          return errorResult(`${target} is a directory. Pass recursive: true to delete its contents.`);
        }
        await fsp.rm(target, { recursive: true, force: false });
        return json({ path: target, deleted: true, wasDirectory: stats.isDirectory() });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_search',
    {
      title: 'Search file contents',
      description:
        'Recursively search files for a literal string or a regular expression and return matching lines.',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: z.object({
        path: pathSchema.optional().describe('Directory to search. Defaults to the allowed root.'),
        pattern: z.string(),
        regex: z.boolean().optional().describe('Treat pattern as a JavaScript regular expression.'),
        include_hidden: z.boolean().optional(),
        max_matches: z.number().int().min(1).optional(),
        max_file_bytes: z.number().int().min(1).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const root = assertPath(args.path, config);
        const maxMatches = args.max_matches ?? config.limits.maxSearchMatches;
        const maxFileBytes = args.max_file_bytes ?? 2 * 1024 * 1024;
        const literal = args.regex ? null : args.pattern;
        let expression = null;
        if (args.regex) {
          try {
            expression = new RegExp(args.pattern);
          } catch (error) {
            return errorResult(`bad regular expression ${args.pattern}: ${error.message}`);
          }
        }
        const matches = [];
        let filesScanned = 0;
        let skipped = 0;

        const walk = async (dir) => {
          if (matches.length >= maxMatches) return;
          let dirents;
          try {
            dirents = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const dirent of dirents) {
            if (matches.length >= maxMatches) return;
            if (!args.include_hidden && dirent.name.startsWith('.')) continue;
            const full = path.join(dir, dirent.name);
            if (dirent.isDirectory()) {
              await walk(full);
              continue;
            }
            if (!dirent.isFile()) continue;
            let stats;
            try {
              stats = await fsp.stat(full);
            } catch {
              continue;
            }
            if (stats.size > maxFileBytes) {
              skipped += 1;
              continue;
            }
            filesScanned += 1;
            let content;
            try {
              content = await fsp.readFile(full, 'utf8');
            } catch {
              skipped += 1;
              continue;
            }
            if (content.includes('\0')) {
              skipped += 1;
              continue;
            }
            const lines = content.split('\n');
            for (const [index, line] of lines.entries()) {
              if (matches.length >= maxMatches) break;
              const hit = expression ? expression.test(line) : line.includes(literal);
              if (hit) {
                matches.push({ path: path.relative(root, full), line: index + 1, text: line.slice(0, 500) });
              }
            }
          }
        };

        await walk(root);
        return json({ root, pattern: args.pattern, filesScanned, skipped, count: matches.length, truncated: matches.length >= maxMatches, matches });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_tar',
    {
      title: 'Create, list or extract a tar archive',
      description:
        'Bulk file transfer helper. create archives paths into archive, list shows contents, extract unpacks an archive.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: z.object({
        action: z.enum(['create', 'list', 'extract']),
        archive: pathSchema,
        paths: z.array(z.string()).optional().describe('Paths to archive, relative to cwd. Required for create.'),
        cwd: z.string().optional(),
        confirm: z.boolean().optional().describe('Required for extract, which writes files.'),
      }),
    },
    async (args, { config }) => {
      try {
        const archive = assertPath(args.archive, config, { write: args.action !== 'list' });
        if (args.action === 'create') {
          if (!args.paths || args.paths.length === 0) return errorResult('create needs at least one path');
          const cwd = args.cwd ? assertPath(args.cwd, config) : path.dirname(archive);
          const result = await run({
            command: 'tar',
            args: ['-cf', archive, ...args.paths],
            cwd,
            config,
            timeoutMs: 120000,
          });
          if (result.exitCode !== 0) return errorResult(`tar failed: ${result.stderr || result.stdout}`);
          const stats = await fsp.stat(archive);
          return json({ archive, bytes: stats.size, included: args.paths });
        }
        if (args.action === 'list') {
          const result = await run({
            command: 'tar',
            args: ['-tf', archive],
            config,
            timeoutMs: 60000,
          });
          if (result.exitCode !== 0) return errorResult(`tar failed: ${result.stderr || result.stdout}`);
          return text(result.stdout);
        }
        if (args.confirm !== true) {
          return errorResult(`refused: extracting ${archive} writes files. Re-run with confirm: true.`);
        }
        const destination = args.cwd ? assertPath(args.cwd, config, { write: true }) : path.dirname(archive);
        const result = await run({
          command: 'tar',
          args: ['-xf', archive, '-C', destination],
          config,
          timeoutMs: 120000,
        });
        if (result.exitCode !== 0) return errorResult(`tar failed: ${result.stderr || result.stdout}`);
        return json({ archive, destination, extracted: true });
      } catch (error) {
        return errorResult(describeError(error));
      }
    },
  );

  register(
    'fs_download',
    {
      title: 'Download a URL to a file',
      description: 'Fetch an http(s) URL and write the response body to a file on the device.',
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      inputSchema: z.object({
        url: z.string(),
        to: pathSchema,
        timeout_ms: z.number().int().min(1000).optional(),
      }),
    },
    async (args, { config }) => {
      try {
        const target = assertPath(args.to, config, { write: true });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), args.timeout_ms ?? 120000);
        try {
          const response = await fetch(args.url, { signal: controller.signal, redirect: 'follow' });
          if (!response.ok) {
            return errorResult(`download failed: HTTP ${response.status} ${response.statusText}`);
          }
          const buffer = Buffer.from(await response.arrayBuffer());
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await fsp.writeFile(target, buffer, { mode: 0o600 });
          return json({
            path: target,
            bytes: buffer.length,
            contentType: response.headers.get('content-type'),
            finalUrl: response.url,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        return errorResult(`download failed: ${describeError(error)}`);
      }
    },
  );
}

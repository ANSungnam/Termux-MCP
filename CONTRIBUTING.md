# Contributing

Thanks for helping. This project is young and the surface is large, so small focused pull
requests are much easier to land than sweeping rewrites.

## Getting set up

```sh
git clone https://github.com/YSCodex/termux-mcp.git
cd termux-mcp
npm install                # or: npm install --no-bin-links on shared storage
node scripts/check.mjs
node test/smoke.mjs
```

Node 20 or newer. There is no build step, no transpiler and no bundler: the server runs the
files in `src/` directly. Keep it that way unless there is a strong reason.

## Before you push

```sh
node scripts/check.mjs     # syntax check plus a credential scan
node test/smoke.mjs        # 35 tests, no device required
```

CI runs both on every push, plus a live boot of the HTTP server that asserts a bad token gets a
`401` and a bad Host gets a `403`. If CI is unhappy, it will be about one of the three.

## Adding a tool

1. Put it in the file that matches its family: `src/tools/shell.js`, `fs.js`, `api.js`,
   `system.js`.
2. Use the `register(name, definition, handler)` helper. The handler receives
   `(args, { config, authInfo, mode })`.
3. **Set `annotations.readOnlyHint` correctly.** The scope gate reads that flag to decide whether
   a `read` token may call the tool. Marking a mutating tool as read-only is a security bug.
4. Mark irreversible operations with `destructiveHint: true` and require `confirm: true`:
   ```js
   if (args.confirm !== true) {
     return errorResult(`refused: <what this does> cannot be undone. Re-run with confirm: true.`);
   }
   ```
5. Route file access through `assertPath` from `src/policy.js`, with `{ write: true }` when you
   are modifying anything. Never build a path with string concatenation.
6. Route command execution through `assertCommandAllowed` so the destructive set applies, and use
   `run` from `src/exec.js` so timeouts, output caps and process-group cleanup come for free.
7. Return `errorResult` with a sentence that tells the caller what to do next. The message is
   often the only thing a model sees before it gives up.
8. Add a test to `test/smoke.mjs`, including the refusal path if the tool has one.

## Style

- ES modules, 2-space indent, semicolons, single quotes — match the surrounding file.
- No build step, no new runtime dependency without a good reason. Every dependency ships to a
  phone over a VPN.
- No secrets, ever. `scripts/check.mjs` scans for credential patterns and fails the build.
  `config.json` holds real tokens and is gitignored.
- Prefer a clear error message over a defensive `try` that swallows the reason.

## Testing on a device

Most of the suite runs anywhere. The termux-api wrappers are the exception: they need the
Termux:API app, and their flags come from the installed `termux-api` package. If you touch
`src/tools/api.js`, check the flags against the wrapper on your device:

```sh
sed -n '/show_usage/,/^}/p' $PREFIX/bin/termux-notification
```

If a tool cannot be exercised on your setup, say so in the pull request rather than claiming it
works.

## Reporting bugs

Open an issue with the Termux version (`termux-info`), the Node version (`node -v`), the command
you ran, what you expected, and what happened. If a tool returned a refusal, paste it verbatim —
the refusal text usually identifies the gate that fired.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

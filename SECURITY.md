# Security Policy

## The short version

`termux-mcp` gives whoever holds a `full` token **shell access to your phone**, plus the Android
APIs Termux has been granted: camera, microphone, location, contacts, SMS, notifications,
clipboard. There is no sandbox around the shell, by design. Deploy it the way you would deploy
an SSH server with password auth, not like a web app.

## Threat model

**In scope**

- A remote attacker who obtains a token, or who can reach the HTTP port.
- A malicious or confused agent that has a `full` token and follows instructions from untrusted
  content (a web page, a repository README, a file the user asked it to read).
- A compromised client machine on the same network.

**Out of scope**

- Anything requiring root. Termux runs unprivileged; so does this server.
- Other Android apps on the device. The Termux sandbox still applies.
- Physical access to an unlocked device.

## What the server does

| Control | Detail |
|---|---|
| Destructive command gate | Commands matching the destructive set are refused unless the caller passes `confirm: true`. Covers recursive deletes, `mkfs`, `dd` to a device, block-device writes, fork bombs, package removal, reboots, `su`, SELinux tampering and `/system` writes. |
| Confirmation on mutating tools | `fs_delete`, `fs_move` over an existing target, `fs_tar extract`, `pkg_upgrade`, `proc_kill`, `sms_send`, `tmux_kill` all require `confirm: true`. |
| Jailed file API | `fs_*` tools resolve against `paths.allow` and subtract `paths.deny`, with per-entry `except` lists. The default deny list hides system partitions, `/proc`, `/dev`, `/etc` and other apps' data. |
| Protected files | The audit log and the config file cannot be written or deleted through any tool, so an agent cannot erase its own trail or escalate by rewriting the policy. |
| Token scopes | `read` reaches read-only tools; `full` reaches everything. The split is derived from each tool's `readOnlyHint` annotation, so it cannot drift from the tool list. |
| Constant-time token compare | Bearer tokens are compared as SHA-256 digests with `crypto.timingSafeEqual`. |
| Host and Origin validation | Requests whose `Host` is not in `http.allowedHosts` get `403`, which blunts DNS-rebinding attacks against a locally bound server. |
| Path traversal | `..` segments are resolved before the allow/deny check, so traversal cannot escape the jail. |
| Output caps | Per-command output, file reads, search matches, listing depth and concurrent jobs are all capped, so a runaway command cannot exhaust memory or the disk. |
| Timeout containment | Timed-out commands have their entire process group signalled, not just the direct child. |
| Audit log | Every tool call, refusal, auth attempt and process signal is written to `~/.termux-mcp/audit.log` as JSON lines, rotating at 5 MiB. |
| stdio is unrestricted | A client that launches the server over stdio already has local code execution, so no token is required. Treat stdio as full trust. |

## What the server cannot do

- It does not prevent an authorized agent from reading your Termux files, exfiltrating them over
  the network, or installing software. No design can, short of removing the tools.
- It does not protect the Termux:API permissions you have already granted. If Termux can read
  your contacts, so can any tool that calls `contact_list`.
- It does not encrypt transport. Run it over a VPN or an SSH tunnel, not over an open network.

## Hardening checklist

1. **Bind to a VPN address**, never `0.0.0.0`. Tailscale and WireGuard are the easy answers.
2. **Set `http.allowedHosts`** to the exact address clients use. A wildcard defeats the check.
3. **Keep `config.json` at `600`**, inside Termux's private directory, never in a git repo.
4. **Use the `read` token** for any client that only browses. Reserve `full` for deliberate
   interactive sessions.
5. **Rotate tokens** with `node bin/termux-mcp.mjs --init` and update the clients. Old tokens
   stop working immediately because the file is the only source of truth.
6. **Review the audit log** after granting access to a new agent: `audit_tail`, or
   `tail -f ~/.termux-mcp/audit.log`.
7. **Prune the `read` scope** if a client does not need `contact_list`, `call_log`, `sms_list`,
   `camera_photo` or `mic_record`. Delete those tools from `src/tools/api.js` or deny them in
   `api.deny` if you never want them reachable.
8. **Revoke Termux:API permissions** you do not need. The server cannot escalate past them, so
   tightening Android settings is the strongest control you have.
9. **Prefer SSH.** An SSH tunnel exposes nothing to the network and inherits SSH's own auth.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting on the repository, or email the maintainer. Include the version, how you reached the
server, and what you were able to do.

We aim to acknowledge a report within a few days. Please give us a reasonable window to ship a
fix before disclosing publicly.

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
| Host and Origin validation | Requests whose `Host` is not in `http.allowedHosts` get `403`, which blunts DNS-rebinding attacks against a locally bound server. Entries may be exact hosts, IPv4 CIDR ranges, or `*`. |
| IPv4-only listener | `bind: 0.0.0.0` creates an IPv4 socket only, so a globally routable IPv6 address on the phone is not exposed by a wildcard bind. The server reports at startup if it finds one. |
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

1. **Prefer `127.0.0.1` or an SSH tunnel when you can.** `0.0.0.0` is for the convenience case —
   a laptop on the phone's own hotspot — and it means anything on that network can reach the port.
   With SSH nothing is exposed at all.
2. **If you bind `0.0.0.0`, keep the private-range allowlist.** The default
   `192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10` plus loopback is deliberate. Never
   put `0.0.0.0/0` or `*` in `allowedHosts` on a network you do not control: that turns off the
   DNS-rebinding guard entirely, and bearer tokens become the only thing standing between a
   browser on your LAN and a shell on your phone.
3. **Rotate the tokens after any hotspot use** if you are not sure who joined. `node
   bin/termux-mcp.mjs --init --force` and check `audit_tail` for the session.
4. **Set `http.allowedHosts`** to the exact address clients use, or the ranges they use. A
   wildcard defeats the check.
5. **Keep `config.json` at `600`**, inside Termux's private directory, never in a git repo. Note
   that `/storage` is world-readable to other apps on many devices, so do not keep the config
   there.
6. **Use the `read` token** for any client that only browses. Reserve `full` for deliberate
   interactive sessions.
7. **Review the audit log** after granting access to a new agent: `audit_tail`, or
   `tail -f ~/.termux-mcp/audit.log`.
8. **Prune the `read` scope** if a client does not need `contact_list`, `call_log`, `sms_list`,
   `camera_photo` or `mic_record`. Delete those tools from `src/tools/api.js` or deny them in
   `api.deny` if you never want them reachable.
9. **Revoke Termux:API permissions** you do not need. The server cannot escalate past them, so
   tightening Android settings is the strongest control you have.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private vulnerability
reporting on the repository, or email the maintainer. Include the version, how you reached the
server, and what you were able to do.

We aim to acknowledge a report within a few days. Please give us a reasonable window to ship a
fix before disclosing publicly.

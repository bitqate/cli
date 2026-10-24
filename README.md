# bitqate

Command-line interface for the BitQate public API (`/v1`). Manage VPSes and
container servers from a terminal, a script, or an agent — using scoped API
tokens instead of your account session.

## Install

```sh
npm i -g @bitqate/cli
```

Standalone binaries for Linux, macOS and Windows are attached to each release
alongside `SHA256SUMS`. Verify a download with:

```sh
sha256sum -c SHA256SUMS --ignore-missing
```

From source (requires Bun for development):

```sh
git clone https://github.com/bitqate/cli.git
cd cli
bun install
bun run build
node dist/bitqate.js --help
```

The bundle targets Node.js >= 20 and also runs under Bun.

## Quick start

Create a token in the dashboard under **Settings → API tokens**, pick the
scopes you need, then:

```sh
bitqate auth login            # hidden prompt
# or, for pipes and CI:
printf '%s' "$TOKEN" | bitqate auth login --token-stdin
```

Then:

```sh
bitqate account
bitqate vms list
bitqate servers list
```

Tokens are stored per profile in `~/.config/bitqate/config.json` (mode 0600).
Manage them with `auth status`, `auth list`, `auth switch`, `auth logout`.
`BITQATE_TOKEN` always takes precedence over the stored profile.

## Token scopes

Each command declares the scope it needs (`bitqate help <command>` shows it,
and `bitqate schema` lists all of them for agents).

| Scope | Unlocks | Notes |
| --- | --- | --- |
| `account:read` | `account`, `workspaces list`, `transactions list` | read-only |
| `vms:read` | `vms list/get/os/nodes/networking/stats/wait`, `vms backups list` | read-only |
| `vms:power` | `vms start/stop/restart` | |
| `vms:write` | `vms create/resize/rename/auto-renew/renew/rdns`, `vms backups create` | **can charge your balance** |
| `vms:delete` | `vms delete/reinstall`, `vms backups restore/delete` | **destroys data** |
| `servers:read` | `servers list/get/install-state`, `servers backups list`, `servers deployments *` | read-only |
| `servers:power` | `servers start/stop/restart` | |
| `servers:write` | `servers create/renew/auto-renew/rename/resize/ports/startup/deploy`, `servers backups create` | **can charge your balance** |
| `servers:delete` | `servers delete/reinstall`, `servers backups restore/delete` | **destroys data** |
| any valid token | `prices`, `vms nodes`, `vms os`, `servers regions`, `auth status` | catalog endpoints |

Deliberately absent from API tokens: changing passwords, console tickets,
buying IP addresses, git connect/disconnect, and anything admin.

## Command reference

Top level: `auth login|logout|status|list|switch`, `account`,
`workspaces list`, `transactions list`, `prices`, `schema`, `version`,
`completion bash|zsh|fish`, `help <command>`.

```
vms      list | get <id> | nodes | os [--node <id>]
vms      create --node <n> --os <os> --memory-mb <n> --cpus <n> --disk-gb <n>
                [--name <n>] [--ssh-key-file <path.pub>] [--workspace <id>]
                [--auto-renew] [--wait] [--dry-run]
vms      start|stop|restart <id> [--wait] [--wait-timeout <s>]
vms      resize <id> [--memory-mb|--cpus|--disk-gb]
vms      rename <id> <name> | auto-renew <id> on|off | renew <id>
vms      reinstall <id> --os <id> | delete <id>        # destructive
vms      backups list|create <id>
vms      backups restore|delete <id> <token>          # destructive
vms      networking <id> | rdns <id> --address <ip> --hostname <name>
vms      stats <id> [--range hour|day|week|month|year] [--cf AVERAGE|MAX]
vms      wait <id> --status <s> [--wait-timeout <s>]

servers  list | get <id> | regions
servers  create --name <n> --region <daemonId> --memory-mb <n> --cpus <n>
                --disk-gb <n>  plus exactly one of:
                --image <ref> | --egg-url <url> | --dockerfile <path> | --git
                [--env K=V ...] [--startup <cmd>] [--workspace <id>]
                [--wait] [--dry-run]
servers  start|stop|restart <id> [--wait]
servers  reinstall <id> [--image|--egg-url] | delete <id>   # destructive
servers  renew <id> | auto-renew <id> on|off | rename <id> <name>
servers  resize <id> [--memory-mb|--cpus|--disk-gb]
servers  ports <id> [--port internal[:tcp|udp] ...]
servers  startup <id> [--command <cmd>] [--env K=V ...]
servers  install-state <id> | wait <id> --status <s>
servers  backups list|create <id>
servers  backups restore|delete <id> <backupId>             # destructive
servers  deploy <id> [--follow]
servers  deployments list <id> | get|logs <id> <deployId>
```

`--cpus` accepts fractions (`1.5` → 150 CPU units on servers, `1.5` cores on
VMs). `servers create --git` creates the server only; connect the repository
in the dashboard afterwards.

## Using with agents and CI

- `BITQATE_TOKEN` supplies the token without touching the config file.
- Global flags work in any position: `bitqate --json vms list` and
  `bitqate vms list --json` are equivalent, as are `--profile ci` and
  `--api-url=…` before the command.
- `--json` (or `BITQATE_OUTPUT=json`) prints the API payload without
  `success`: lists as arrays, objects as objects, actions as
  `{ id?, message, ... }`. Errors go to stderr as
  `{"error":{"code","message","status?","retry_after?"}}`. In human mode
  errors print as `error: <message>` with an optional `hint:` line.
- Exit codes: 0 ok · 1 server/network · 2 usage or 400/422 · 3 missing/bad
  token or 401 · 4 403 (including missing scope) · 5 404 · 6 409 · 7 429 ·
  8 402 · 9 wait timeout.
- `bitqate schema` dumps every command, flag, scope and destructive marker as
  JSON — designed for tool discovery by agents.
- `-y/--yes` is required for destructive commands when not on a TTY.
- `--dry-run` prints the method, URL and JSON body without sending anything.
- `-q/--quiet` prints only resource IDs, one per line — easy to pipe.
- `--verbose` writes `METHOD url -> status (ms)` to stderr; tokens are never
  logged.
- Prefer least-privilege tokens with an expiry for CI (e.g. only
  `vms:read`+`vms:power` for a restart cron).

## Configuration

`config.json` lives in `BITQATE_CONFIG_DIR` > `$XDG_CONFIG_HOME/bitqate` >
`~/.config/bitqate` and looks like
`{"version":1,"current":"default","profiles":{"default":{"api_url":"...","token":"bqat_..."}}}`.
API URL precedence: `--api-url` > `BITQATE_API_URL` > profile > `https://api.bitqate.com`.

## Security notes

- Tokens are only sent over HTTPS (HTTP is allowed solely for localhost) and
  are never printed, logged, or forwarded to redirects (`redirect: manual`).
- A stored profile token is bound to the API origin it was logged in with.
  Pointing `--api-url` or `BITQATE_API_URL` at a different origin with a
  profile token fails closed (exit 3); use `BITQATE_TOKEN` or a dedicated
  profile for other endpoints.
- There is no `--token` flag so secrets stay out of argv, shell history and
  `ps`; use stdin or the hidden prompt.
- All request paths are built from validated, percent-encoded segments under
  `/v1/`. Traversal like `../admin` is a usage error, not a request.
- Non-GET requests are never retried automatically, so a flaky network cannot
  double-charge a create or renew. GETs retry 429 (bounded) and once on
  network errors.
- Server-provided strings are stripped of control characters before printing
  to a terminal.
- Config files are written atomically with 0600 permissions.

## License

Apache License 2.0. See [LICENSE](LICENSE). The license does not grant rights to
the BitQate name or logo.

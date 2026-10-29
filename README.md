# bitqate

Command-line interface for the BitQate public API (`/v1`). Manage VPSes and
container servers from a terminal, a script, or an agent — using scoped API
tokens instead of your account session.

## Install

```sh
npm i -g @bitqate/cli
```

Or with [uv](https://docs.astral.sh/uv/), no Node required. `uvx` runs it
without installing, `uv tool install` puts it on your PATH:

```sh
uvx bitqate --help
uv tool install bitqate
```

`pipx install bitqate` and `pip install bitqate` work too. The PyPI wheels
wrap the standalone binaries below and cover Linux x64/arm64 (glibc), macOS
(Intel and Apple silicon) and Windows x64.

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

On a terminal, most commands go further: `bitqate vms list` prints a table
with coloured status dots and short IDs, `bitqate vms get dizzy-puma` a
detail view with next-step hints, and `bitqate vms create` a full
interactive wizard (region, OS, size presets with monthly prices, SSH key
picker, review and confirm). Everything still works non-interactively —
every question maps to a flag.

```
$ bitqate vms stop dizzy-puma --wait
⠋ Stopping dizzy-puma  stopping · 0:03
✓ Stopped dizzy-puma
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
| `servers:read` | `servers list/get/install-state/logs`, `servers backups list`, `servers deployments list/get/logs`, `servers health get`, `servers network get` | read-only |
| `servers:power` | `servers start/stop/restart` | |
| `servers:write` | `servers create/renew/auto-renew/rename/resize/ports/startup/deploy`, `servers backups create`, `servers deployments rollback`, `servers health set/clear`, `servers network enable/disable` | **can charge your balance** |
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
                | --dir <path>
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
servers  deploy <id> [--dir <path>] [--dockerfile <path>] [-m <text>] [--follow]
servers  deployments list <id> | get|logs <id> <deployId>
servers  deployments rollback <id> [deployId] [--follow]
servers  logs <id> [-f] [--tail <n>] [--since 10m|<date>] [-t]
servers  health get <id> | clear <id>
servers  health set <id> [--type http|tcp] [--path /healthz] [--interval <s>]
                [--timeout <s>] [--failures <n>] [--grace <s>] [--no-restart]
servers  network get <id> | enable <id> [--hostname <name>] | disable <id>
```

`servers logs` prints the container's own output; `-f` keeps streaming
across restarts and redeploys until Ctrl-C (NDJSON `{"t","line"}` with
`--json`). `deployments rollback` rebuilds the exact commit of an earlier
successful deployment (default: the one before the live version).
`health set` makes git deploys wait for the check before switching traffic,
restores the previous version when a deploy never passes it, and restarts a
running server that keeps failing (at most 3 times an hour).
`network enable` puts the server on its workspace's private network: servers
on the same node reach each other at `<hostname>.internal`, from the
server's next restart.

`--cpus` accepts fractions (`1.5` → 150 CPU units on servers, `1.5` cores on
VMs). `servers create --git` creates the server only; connect the repository
in the dashboard afterwards, or upload local code with
`servers deploy <id> --dir .`

## Using with agents and CI

- `BITQATE_TOKEN` supplies the token without touching the config file.
- Global flags work in any position: `bitqate --json vms list` and
  `bitqate vms list --json` are equivalent, and `--profile ci` works
  before or after the command.
- `--json` (or `BITQATE_OUTPUT=json`) prints the API payload without
  `success`: lists as arrays, objects as objects, actions as
  `{ id?, message, ... }`. Errors go to stderr as
  `{"error":{"code","message","status?","retry_after?"}}`. In human mode
  errors print as `error: <message>` with an optional `hint:` line.
- Exit codes: 0 ok · 1 server/network · 2 usage or 400/422 · 3 missing/bad
  token or 401 · 4 403 (including missing scope) · 5 404 · 6 409 · 7 429 ·
  8 402 · 9 wait timeout · 130 user cancel (Ctrl-C/Esc in a prompt or wait).
- `bitqate schema` dumps every command, flag, scope and destructive marker as
  JSON — designed for tool discovery by agents.
- Aliases work everywhere: `vm`/`srv`/`server` for `vms`/`servers`,
  `ls`/`show`/`info`/`rm`/`new` for `list`/`get`/`delete`/`create`, and
  `whoami` for `account`. They appear in help, completion and `schema`.
- Any VM/server argument accepts a name, a short ID prefix, or a full
  UUID. Names resolve via the list endpoint (needs the matching `:read`
  scope); a UUID is used directly with no list call. Ambiguous matches
  open a picker on a TTY or print the candidates otherwise.
- On a TTY, `vms create` and `servers create` run interactive wizards
  (game-server catalog included: `--game paper`). `--dry-run` prints the
  request body instead of sending it; `--yes` skips the final confirm.
  Both return as soon as the API accepts the request; pass `--wait` to
  block until a VM is running or a game server has finished installing.
- `vms ssh <name>` connects over SSH (with `--json` it prints
  `{host, user, port, host_key_fingerprint}` instead), and `open <name>`
  (or `vms open` / `servers open`) opens the dashboard in a browser.
- `-y/--yes` is required for destructive commands when not on a TTY; on a
  TTY you're asked to type the resource name back.
- `--dry-run` prints the method, URL and JSON body without sending anything.
- `-q/--quiet` prints only resource IDs, one per line — easy to pipe.
- `--verbose` writes `METHOD url -> status (ms)` to stderr; tokens are never
  logged.
- Prefer least-privilege tokens with an expiry for CI (e.g. only
  `vms:read`+`vms:power` for a restart cron).

## Configuration

`config.json` lives in `BITQATE_CONFIG_DIR` > `$XDG_CONFIG_HOME/bitqate` >
`~/.config/bitqate` and looks like
`{"version":1,"current":"default","profiles":{"default":{"token":"bqat_..."}}}`.
The CLI only talks to `https://api.bitqate.com`. No flag, environment variable or
config key changes that, so a token is never sent anywhere else.

## Deploy local code

`bitqate servers deploy <server> --dir .` packages a directory and deploys it the same way a push does, without going through GitHub. `servers create ... --dir . --wait` creates a server from local code in one step. Useful flags: `--dockerfile <path>` picks a Dockerfile inside the directory (default `Dockerfile`), `-m`/`--message <text>` sets the deployment message, and `--follow` streams the build logs.

Inside a git work tree, tracked files plus untracked files that are not gitignored are sent. Outside git, everything is sent except default excludes (`node_modules`, `.git`, `.next`, `.venv` and similar). `.dockerignore` filters on top either way, and the Dockerfile is always included.

The archive must compress to 50 MB or less, so leave dependencies and build output out; they're rebuilt on the server. Your server's environment variables are available while the image builds and when it runs. Uploaded deployments can't be rolled back because their files aren't kept, and on a GitHub-connected server the next push replaces the upload.

## License

Apache License 2.0. See [LICENSE](LICENSE). The license does not grant rights to
the BitQate name or logo.

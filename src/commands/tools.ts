import { isIP } from 'node:net';
import { spawn } from 'node:child_process';
import { CliError, usageError } from '../core/errors';
import { openUrl, portalUrl } from '../core/portal';
import { isUuid, resolveResource } from '../core/resolve';
import { register } from '../registry';
import { sanitize } from '../core/output';
import { shortId } from '../ui/format';

async function openTarget(
  url: string,
  io: { json: boolean; interactive: boolean },
) {
  await openUrl(url);
  return { url };
}

register({
  path: ['open'],
  summary: 'Open a resource in the BitQate dashboard',
  args: [
    {
      name: 'ref',
      required: false,
      description: 'VM or server name/ID (opens the portal home when omitted)',
    },
  ],
  flags: {},
  scope: 'any',
  examples: ['bitqate open', 'bitqate open dizzy-puma'],
  async run(ctx) {
    if (!ctx.args.length) {
      const url = portalUrl('home');
      if (!ctx.io.json && ctx.io.interactive) await openTarget(url, ctx.io);
      return {
        data: { url },
        render: (d) => ({ lines: [`Opening ${d.url}`] }),
      };
    }
    const ref = ctx.args[0];
    let vm: { id: string; name: string } | null = null;
    let srv: { id: string; name: string } | null = null;
    if (isUuid(ref)) {
      vm = { id: ref, name: ref };
    } else {
      try {
        vm = await resolveResource(ctx, 'vms', ref, ctx.io.theme);
      } catch {}
      try {
        srv = await resolveResource(ctx, 'servers', ref, ctx.io.theme);
      } catch {}
      if (!vm && !srv)
        throw new CliError('not_found', `No VM or server matches '${ref}'`, {
          hint: 'Run bitqate vms list or bitqate servers list',
        });
    }
    const target = vm ?? srv;
    if (!target) throw usageError('Nothing to open');
    const url = portalUrl(srv && !vm ? 'server' : 'vm', target.id);
    if (!ctx.io.json && ctx.io.interactive) await openTarget(url, ctx.io);
    return {
      data: { url },
      render: (d) => ({ lines: [`Opening ${d.url}`] }),
    };
  },
});

const VM_BUSY = new Map([
  ['creating', 'is still being created'],
  ['reinstalling', 'is being reinstalled'],
]);

export function vmBusy(status: unknown): string | null {
  return VM_BUSY.get(String(status)) ?? null;
}

export async function sshInto(
  ctx: {
    api: () => any;
    args: string[];
    flags: Record<string, any>;
    io: { json: boolean; interactive: boolean; theme: any };
  },
  ref: string | undefined,
): Promise<{ data: unknown; render?: any }> {
  const { id, name } = await resolveResource(
    ctx as any,
    'vms',
    ref,
    ctx.io.theme,
  );
  const resp = await ctx.api().get(['vms', id]);
  const vm = resp?.vm;
  if (!vm) throw new CliError('not_found', `No VM matches '${ref}'`);
  const busy = vmBusy(vm.status);
  if (busy) {
    const who = ref ?? name;
    throw new CliError(
      'conflict',
      `${who} ${busy}. You can SSH in once it's ready.`,
      { hint: `Check progress with bitqate vms get ${who}` },
    );
  }
  const host =
    vm.ipv4 ??
    vm.networking?.ips?.find((i: any) => i.version === 4)?.address ??
    vm.ips?.[0]?.address;
  if (!host || !isIP(host))
    throw new CliError('server', `VM '${name}' has no reachable IP address`);
  const user = ctx.flags.user ?? 'root';
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user))
    throw usageError(`Invalid --user '${user}'`);
  const fingerprint =
    vm.ssh?.host_key_fingerprint ?? vm.host_key_fingerprint ?? null;
  if (ctx.io.json) {
    return {
      data: { host, user, port: 22, host_key_fingerprint: fingerprint },
    };
  }
  process.stderr.write(
    `${sanitize(`Connecting to ${user}@${host}`)}${fingerprint ? ` · host key ${sanitize(fingerprint)}` : ''}\n`,
  );
  const extra = ctx.flags['--'] ?? [];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn('ssh', [`${user}@${host}`, ...extra], {
      stdio: 'inherit',
    });
    child.on('error', () =>
      reject(
        new CliError('server', 'Could not run ssh', {
          hint: 'Install OpenSSH or use the web console in the dashboard',
        }),
      ),
    );
    child.on('close', (c) => resolve(c ?? 0));
  });
  process.exitCode = code;
  return { data: { host, user, code } };
}

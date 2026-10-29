import { waitPoll } from '../core/confirm';
import { sanitize } from '../core/output';
import type { RunContext } from '../registry';

export async function followDeployment(
  ctx: RunContext,
  resolved: { id: string; name: string },
  deploymentId: string,
  timeoutMs: number,
): Promise<any> {
  let printed = 0;
  const dep = await waitPoll(
    { name: resolved.name, kind: 'servers' },
    async () => {
      const logs = await ctx
        .api()
        .get(['servers', resolved.id, 'deployments', deploymentId, 'logs']);
      const lines: string[] = logs?.lines ?? [];
      const sink = ctx.io.json ? process.stderr : process.stdout;
      for (; printed < lines.length; printed++)
        sink.write(`${sanitize(lines[printed])}\n`);
      if (!logs?.done) return { value: null, status: 'deploying' };
      const detail = await ctx
        .api()
        .get(['servers', resolved.id, 'deployments', deploymentId]);
      const status = detail?.deployment?.status ?? 'unknown';
      return { value: detail?.deployment ?? { status }, status };
    },
    { timeoutMs, label: 'deployment' },
  );
  return dep;
}

import { CliError } from '../core/errors';
import { sanitize } from '../core/output';
import type { Theme } from '../ui/theme';
import { confirm, select } from '../ui/prompts';
import { money, moneyMo } from '../ui/format';
import type { RunContext } from '../registry';

export function answered(theme: Theme, label: string, value: string): void {
  process.stderr.write(
    `${theme.paint('success', theme.glyph('check'))} ${label}  ${theme.paint('muted', value)}\n`,
  );
}

export interface WizardData {
  prices: Record<string, number>;
  account: any;
  workspaces: any[];
}

export async function loadForWizard(
  ctx: RunContext,
  endpoints: Record<string, string[]>,
): Promise<{ results: Record<string, any>; account: any; workspaces: any[] }> {
  const keys = Object.keys(endpoints);
  const calls = keys.map((k) =>
    ctx
      .api()
      .get(endpoints[k])
      .then((r: any) => [k, r] as const),
  );
  const settled = await Promise.all([
    ...calls,
    ctx
      .api()
      .get(['account'])
      .catch(() => null),
  ]);
  const results = Object.fromEntries(settled.slice(0, keys.length));
  const account = settled[keys.length];
  const workspaces = account
    ? await ctx
        .api()
        .get(['workspaces'])
        .catch(() => null)
    : null;
  return {
    results,
    account: account?.account,
    workspaces: (workspaces?.workspaces ?? []).filter(
      (w: any) => w.balance != null,
    ),
  };
}

export async function pickWorkspace(
  flagValue: string | undefined,
  workspaces: any[],
  theme: Theme,
): Promise<string | undefined> {
  if (flagValue || !workspaces.length) return flagValue;
  const picked = await select(
    {
      message: 'Billed to',
      options: [
        { label: 'Personal account', value: '' },
        ...workspaces.map((w: any) => ({
          label: w.name,
          value: w.id,
          hint: w.role,
        })),
      ],
    },
    theme,
  );
  return picked || undefined;
}

export function reviewBlock(
  theme: Theme,
  fields: [string, string | undefined][],
  monthly: number | null,
  balance: number | null,
): void {
  process.stderr.write(`\n${theme.paint('strong', 'Review')}\n\n`);
  const w = Math.max(...fields.map(([l]) => l.length));
  for (const [l, v] of fields)
    if (v !== undefined && v !== '')
      process.stderr.write(
        `  ${theme.paint('muted', l.padEnd(w))}  ${sanitize(v)}\n`,
      );
  if (monthly == null) {
    process.stderr.write(
      `\n  ${theme.paint('strong', 'Total')}  ${theme.paint('muted', 'price unavailable')}\n`,
    );
    return;
  }
  const after =
    balance != null
      ? ` · balance ${money(balance)} → ${money(balance - monthly)}`
      : '';
  process.stderr.write(
    `\n  ${theme.paint('strong', 'Total')}  ${moneyMo(monthly)}, charged now${after}\n\n`,
  );
  if (balance != null && balance < monthly) {
    process.stderr.write(
      `${theme.paint('danger', theme.glyph('cross'))} Balance too low. Top up at https://portal.bitqate.com/billing\n`,
    );
    throw new CliError('payment_required', 'Balance too low', { status: 402 });
  }
}

export async function confirmCreate(
  theme: Theme,
  what: string,
  monthly: number | null,
  skip: boolean,
): Promise<void> {
  if (skip) return;
  const go = await confirm(
    {
      message: `Create this ${what}${monthly != null ? ` for ${moneyMo(monthly)}` : ''}?`,
      default: true,
    },
    theme,
  );
  if (!go) throw new CliError('cancelled', 'Cancelled.');
}

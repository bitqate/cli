import { kvLines } from '../core/output';
import { register } from '../registry';

register({
  path: ['account'],
  summary: 'Show the account behind the token',
  args: [],
  flags: {},
  scope: 'account:read',
  examples: ['bitqate account', 'bitqate account --json'],
  async run(ctx) {
    const resp = await ctx.api().get(['account']);
    const data = resp?.account ?? {};
    return { data, render: (d) => ({ lines: kvLines(d) }) };
  },
});

register({
  path: ['workspaces', 'list'],
  summary: 'List workspaces you belong to',
  args: [],
  flags: {},
  scope: 'account:read',
  examples: ['bitqate workspaces list', 'bitqate workspaces list -q'],
  async run(ctx) {
    const resp = await ctx.api().get(['workspaces']);
    const data = resp?.workspaces ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['ID', 'NAME', 'ROLE', 'BALANCE'],
          rows: rows.map((w) => [
            w.id ?? '',
            w.name ?? '',
            w.role ?? '',
            w.balance == null ? '-' : String(w.balance),
          ]),
        },
      }),
    };
  },
});

register({
  path: ['transactions', 'list'],
  summary: 'List account transactions',
  args: [],
  flags: {
    workspace: {
      type: 'string',
      description: 'Workspace ID to list team transactions for',
    },
    limit: {
      type: 'string',
      description: 'Maximum number of transactions (1-500, default 50)',
    },
  },
  scope: 'account:read',
  examples: [
    'bitqate transactions list',
    'bitqate transactions list --workspace team-1 --limit 10',
  ],
  async run(ctx) {
    const limit = ctx.flags.limit;
    const resp = await ctx.api().get(['transactions'], {
      workspace: ctx.flags.workspace,
      limit,
    });
    const data = resp?.transactions ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['ID', 'TYPE', 'AMOUNT', 'STATUS', 'REFERENCE', 'CREATED'],
          rows: rows.map((t) => [
            t.id ?? '',
            t.type ?? '',
            `${t.direction === 'out' ? '-' : ''}${t.amount ?? ''} ${t.currency ?? ''}`,
            t.status ?? '',
            t.reference ?? '',
            t.created_at ?? '',
          ]),
        },
      }),
    };
  },
});

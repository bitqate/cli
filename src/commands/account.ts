import { money } from '../ui/format';
import { relTime } from '../ui/format';
import { register } from '../registry';

register({
  path: ['account'],
  summary: 'Show the account behind the token',
  args: [],
  flags: {},
  scope: 'account:read',
  aliases: ['whoami'],
  examples: ['bitqate account', 'bitqate whoami'],
  async run(ctx) {
    const resp = await ctx.api().get(['account']);
    const data = resp?.account ?? {};
    return {
      data,
      render: (d) => ({
        detail: {
          title: `${d.username ?? ''}`,
          fields: [
            ['Email', d.email],
            ['Balance', d.balance != null ? money(d.balance) : undefined],
            ['Member since', relTime(d.created_at)],
          ],
        },
      }),
    };
  },
});

register({
  path: ['workspaces', 'list'],
  summary: 'List your workspaces',
  args: [],
  flags: {},
  scope: 'account:read',
  aliases: ['ls'],
  examples: ['bitqate workspaces list', 'bitqate workspaces list -q'],
  async run(ctx) {
    const resp = await ctx.api().get(['workspaces']);
    const data = resp?.workspaces ?? [];
    return {
      data,
      render: (rows: any[]) => {
        if (!rows.length)
          return { lines: ['No workspaces yet. Create one at https://portal.bitqate.com/workspaces.'] };
        return {
          table: {
            columns: [
              { title: 'Name' },
              { title: 'ID', priority: 2 },
              { title: 'Role', priority: 4 },
              { title: 'Balance', priority: 6 },
            ],
            rows: rows.map((w) => [
              w.name ?? '',
              w.id ?? '',
              w.role ?? '',
              w.balance == null ? '-' : money(w.balance),
            ]),
            footer: `${rows.length} workspace${rows.length === 1 ? '' : 's'}`,
          },
        };
      },
    };
  },
});

register({
  path: ['transactions', 'list'],
  summary: 'List transactions',
  args: [],
  flags: {
    workspace: {
      type: 'string',
      placeholder: 'workspace',
      description: 'Workspace name or ID to list transactions for',
    },
    limit: {
      type: 'string',
      placeholder: 'n',
      description: 'Maximum number of transactions (1-500, default 50)',
    },
  },
  scope: 'account:read',
  aliases: ['ls'],
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
      render: (rows: any[]) => {
        if (!rows.length) return { lines: ['No transactions yet.'] };
        return {
          table: {
            columns: [
              { title: 'ID', priority: 1 },
              { title: 'Type', priority: 4 },
              { title: 'Amount', priority: 8 },
              { title: 'Status', priority: 3 },
              { title: 'Reference', priority: 2, truncate: true },
              { title: 'Created', priority: 6 },
            ],
            rows: rows.map((t) => [
              t.id ?? '',
              t.type ?? '',
              `${t.direction === 'out' ? '-' : ''}${money(t.amount ?? 0)}`,
              t.status ?? '',
              t.reference ?? '',
              relTime(t.created_at),
            ]),
          },
        };
      },
    };
  },
});

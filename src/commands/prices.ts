import { register } from '../registry';

register({
  path: ['prices'],
  summary: 'List resource prices',
  args: [],
  flags: {},
  scope: 'any',
  examples: ['bitqate prices', 'bitqate prices --json'],
  async run(ctx) {
    const resp = await ctx.api().get(['prices']);
    const data = resp?.prices ?? [];
    return {
      data,
      render: (rows: any[]) => ({
        table: {
          head: ['KEY', 'PRICE'],
          rows: rows.map((p) => [p.key ?? '', String(p.price ?? '')]),
        },
      }),
    };
  },
});

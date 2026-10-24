import { moneyMo } from '../ui/format';
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
          columns: [{ title: 'Key' }, { title: 'Price' }],
          rows: rows.map((p) => [
            p.key ?? '',
            typeof p.price === 'number'
              ? moneyMo(p.price)
              : String(p.price ?? ''),
          ]),
          footer: rows.length ? undefined : 'No prices returned.',
        },
      }),
    };
  },
});

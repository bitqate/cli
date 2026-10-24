import { CliError, usageError } from './errors';
import type { RunContext } from '../registry';
import { select } from '../ui/prompts';
import { isInteractive } from '../ui/spinner';
import type { Theme } from '../ui/theme';
import { shortId } from '../ui/format';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NamedResource {
  id: string;
  name?: string;
  [k: string]: unknown;
}

export interface ResolvedRef {
  id: string;
  name: string;
}

const KIND_LABEL: Record<string, { one: string; many: string; scope: string }> =
  {
    vms: { one: 'VM', many: 'vms', scope: 'vms:read' },
    servers: { one: 'server', many: 'servers', scope: 'servers:read' },
  };

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

export async function resolveResource(
  ctx: RunContext,
  kind: 'vms' | 'servers',
  ref: string | undefined,
  theme: Theme,
): Promise<ResolvedRef> {
  const label = KIND_LABEL[kind];
  const picker = async (items: NamedResource[]) => {
    if (!isInteractive()) throw usageError(`Missing required argument <id>`);
    const value = await select(
      {
        message: `Choose a ${label.one}`,
        options: items.map((it) => ({
          label: it.name ?? it.id,
          value: it.id,
          hint: shortId(it.id),
        })),
      },
      theme,
    );
    const picked = items.find((i) => i.id === value);
    if (!picked) throw usageError('Nothing selected');
    return { id: picked.id, name: picked.name ?? picked.id };
  };

  const fetchList = async (): Promise<NamedResource[]> => {
    try {
      const resp = await ctx.api().get([kind]);
      return (resp?.[kind === 'vms' ? 'vms' : 'servers'] ??
        []) as NamedResource[];
    } catch (err) {
      if (err instanceof CliError && err.code === 'forbidden')
        throw new CliError(
          'forbidden',
          `Referring to ${label.many} by name needs the ${label.scope} scope. Pass the full ID or add the scope.`,
          { status: err.status },
        );
      throw err;
    }
  };

  if (ref === undefined) return picker(await fetchList());
  if (isUuid(ref)) return { id: ref, name: ref };

  const items = await fetchList();
  const exact = items.filter((i) => i.name === ref);
  const ci = items.filter(
    (i) => i.name && i.name.toLowerCase() === ref.toLowerCase(),
  );
  const prefix =
    ref.length >= 4 ? items.filter((i) => i.id.startsWith(ref)) : [];
  const candidates = exact.length ? exact : ci.length ? ci : prefix;

  if (candidates.length === 0)
    throw new CliError('not_found', `No ${label.one} matches '${ref}'`, {
      hint: `Run bitqate ${kind} list`,
    });
  if (candidates.length === 1) {
    const r = candidates[0];
    return { id: r.id, name: r.name ?? r.id };
  }
  if (isInteractive()) return picker(candidates);
  const list = candidates
    .map((c) => `${c.name ?? c.id} (${shortId(c.id)})`)
    .join(', ');
  throw usageError(
    `'${ref}' matches ${candidates.length} ${label.many}: ${list}`,
  );
}

export async function resolveOption(
  ctx: Pick<RunContext, 'api'>,
  endpoint: string[],
  ref: string,
  fields: string[],
  label: string,
  filter?: (item: any) => boolean,
): Promise<string> {
  const resp = await ctx.api().get(endpoint);
  const items: any[] = Object.values(resp ?? {}).find(Array.isArray) ?? [];
  const pool = filter ? items.filter(filter) : items;
  const lower = ref.toLowerCase();
  const matches = pool.filter((i) =>
    fields.some(
      (f) => String(i[f] ?? '').toLowerCase() === lower,
    ),
  );
  if (matches.length === 1) return matches[0].id;
  const choices = pool
    .map((i) => fields.map((f) => i[f]).filter(Boolean).join(' / '))
    .slice(0, 12)
    .join(', ');
  throw new CliError(
    'usage',
    matches.length > 1
      ? `'${ref}' matches several ${label}: ${choices}`
      : `Unknown ${label} '${ref}'. Choices: ${choices}`,
  );
}

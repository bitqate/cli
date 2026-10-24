export type PriceMap = Record<string, number>;

export function priceMap(rows: unknown): PriceMap {
  const out: PriceMap = {};
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && typeof r === 'object') {
        const { key, price } = r as { key?: unknown; price?: unknown };
        if (typeof key === 'string' && typeof price === 'number')
          out[key] = price;
      }
    }
  }
  return out;
}

export function vmMonthly(
  spec: {
    memory_mb: number;
    cpus: number;
    disk_gb: number;
    ipv4: boolean;
  },
  prices: PriceMap,
): number | null {
  const need = ['ram-vps', 'cpu-vps', 'disk-vps'];
  if (spec.ipv4) need.push('ip-vps');
  if (need.some((k) => prices[k] === undefined)) return null;
  return (
    (spec.memory_mb / 1024) * prices['ram-vps'] +
    spec.cpus * prices['cpu-vps'] +
    spec.disk_gb * prices['disk-vps'] +
    (spec.ipv4 ? prices['ip-vps'] : 0)
  );
}

export function serverMonthly(
  spec: { ram_mb: number; cpu_units: number; disk_gb: number },
  prices: PriceMap,
): number | null {
  const need = ['ram-game', 'cpu-game', 'disk-game'];
  if (need.some((k) => prices[k] === undefined)) return null;
  return (
    (spec.ram_mb / 1024) * prices['ram-game'] +
    (spec.cpu_units / 100) * prices['cpu-game'] +
    spec.disk_gb * prices['disk-game']
  );
}

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function money(n: number): string {
  return USD.format(Math.floor(n * 100 + 1e-8) / 100);
}

export function moneyMo(n: number): string {
  return `${money(n)}/mo`;
}

export function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function relTime(value: unknown, now: Date = new Date()): string {
  const d = toDate(value);
  if (!d) return value == null ? '-' : String(value);
  const diff = d.getTime() - now.getTime();
  const past = diff < 0;
  const s = Math.abs(diff) / 1000;
  let text: string;
  if (s < 45) return 'just now';
  if (s < 3600) text = `${Math.round(s / 60)} min`;
  else if (s < 86400) {
    const h = Math.round(s / 3600);
    text = `${h} hour${h === 1 ? '' : 's'}`;
  } else if (s < 86400 * 30) {
    const dd = Math.round(s / 86400);
    text = `${dd} day${dd === 1 ? '' : 's'}`;
  } else if (s < 86400 * 365) {
    const m = Math.round(s / (86400 * 30));
    text = `${m} month${m === 1 ? '' : 's'}`;
  } else {
    const y = Math.round(s / (86400 * 365));
    text = `${y} year${y === 1 ? '' : 's'}`;
  }
  return past ? `${text} ago` : `in ${text}`;
}

export function memory(mb: number): string {
  if (!mb) return '0 MB';
  if (mb % 1024 === 0) return `${mb / 1024} GB`;
  return `${mb} MB`;
}

export function vcpu(cores: number): string {
  const label = cores === 1 ? 'vCPU' : 'vCPU';
  return `${cores} ${label}`;
}

export function sizeLine(cores: number, memMb: number, diskGb: number): string {
  return `${vcpu(cores)} · ${memory(memMb)} · ${diskGb} GB`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function truncate(s: string, width: number): string {
  if (width <= 0) return '';
  if (s.length <= width) return s;
  if (width === 1) return '…';
  return `${s.slice(0, width - 1)}…`;
}

export function elapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function elapsedLong(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (!m) return `${s}s`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

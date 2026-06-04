export function normalizeClickHouseDateTime(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)) {
    return raw;
  }

  const date = raw ? new Date(raw) : new Date();
  if (Number.isNaN(date.getTime())) {
    return formatUtc(new Date());
  }

  return formatUtc(date);
}

function formatUtc(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`;
}

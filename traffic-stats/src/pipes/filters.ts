export type PipeQueryParams = Record<string, string | string[] | undefined>;

export function queryString(query: PipeQueryParams, key: string): string | undefined {
  const value = query[key];
  return typeof value === 'string' ? value : undefined;
}

/** The longest stretch one request may ask about. Ghost's own ranges stop at a year. */
export const MAX_RANGE_DAYS = 400;

const DAY_MS = 864e5;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDay(value: string | undefined): number | null {
  if (!value || !DATE_PATTERN.test(value)) {
    return null;
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * The `date_from`/`date_to` a pipe runs over: defaults where missing or not a
 * YYYY-MM-DD date, swapped when reversed, and at most MAX_RANGE_DAYS long
 * (the end kept, the start moved up).
 */
export function dateRange(
  query: PipeQueryParams,
  defaultDays: number,
  now: number = Date.now()
): {dateFrom: string; dateTo: string} {
  let to = parseDay(queryString(query, 'date_to')) ?? Date.parse(`${isoDay(now)}T00:00:00Z`);
  let from = parseDay(queryString(query, 'date_from')) ?? to - defaultDays * DAY_MS;
  if (from > to) {
    [from, to] = [to, from];
  }
  if (to - from > (MAX_RANGE_DAYS - 1) * DAY_MS) {
    from = to - (MAX_RANGE_DAYS - 1) * DAY_MS;
  }
  return {dateFrom: isoDay(from), dateTo: isoDay(to)};
}

export type HitsFilter = {
  whereSql: string;
  queryParams: Record<string, string | string[] | number>;
  limit: number;
  skip: number;
};

export function buildHitsFilter(siteUuid: string, query: PipeQueryParams): HitsFilter {
  const {dateFrom, dateTo} = dateRange(query, 30);
  const limit = Math.min(Math.max(Math.floor(Number(queryString(query, 'limit') ?? 50)) || 50, 1), 500);
  const skip = Math.min(Math.max(Math.floor(Number(queryString(query, 'skip') ?? 0)) || 0, 0), 100_000);

  const queryParams: Record<string, string | string[] | number> = {siteUuid, dateFrom, dateTo};
  const clauses = [
    'site_uuid = {siteUuid:String}',
    'timestamp >= toDateTime({dateFrom:String})',
    'timestamp < toDateTime({dateTo:String}) + INTERVAL 1 DAY'
  ];

  const memberStatus = queryString(query, 'member_status');
  if (memberStatus) {
    let statuses = memberStatus.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.includes('paid') && !statuses.includes('comped')) {
      statuses = [...statuses, 'comped'];
    }
    if (statuses.length > 0) {
      clauses.push('member_status IN {statuses:Array(String)}');
      queryParams.statuses = statuses;
    }
  }

  const equalsFilters: Array<[param: string, column: string]> = [
    ['location', 'location'],
    ['pathname', 'pathname'],
    ['post_uuid', 'post_uuid'],
    ['source', 'source'],
    ['device', 'device'],
    ['utm_source', 'utm_source'],
    ['utm_medium', 'utm_medium'],
    ['utm_campaign', 'utm_campaign'],
    ['utm_term', 'utm_term'],
    ['utm_content', 'utm_content']
  ];

  for (const [param, column] of equalsFilters) {
    const value = queryString(query, param);
    if (value) {
      clauses.push(`${column} = {${param}:String}`);
      queryParams[param] = value;
    }
  }

  const postType = queryString(query, 'post_type');
  if (postType === 'post') {
    clauses.push("post_type = 'post'");
  } else if (postType) {
    clauses.push("(post_type != 'post' OR post_type = '' OR post_type IS NULL)");
  }

  return {
    whereSql: clauses.join(' AND '),
    queryParams,
    limit,
    skip
  };
}

export type PipeQueryParams = Record<string, string | string[] | undefined>;

export function queryString(query: PipeQueryParams, key: string): string | undefined {
  const value = query[key];
  return typeof value === 'string' ? value : undefined;
}

export type HitsFilter = {
  whereSql: string;
  queryParams: Record<string, string | string[] | number>;
  limit: number;
  skip: number;
};

export function buildHitsFilter(siteUuid: string, query: PipeQueryParams): HitsFilter {
  const dateFrom =
    queryString(query, 'date_from') ??
    new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const dateTo = queryString(query, 'date_to') ?? new Date().toISOString().slice(0, 10);
  const limit = Math.min(Number(queryString(query, 'limit') ?? 50) || 50, 500);
  const skip = Number(queryString(query, 'skip') ?? 0) || 0;

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

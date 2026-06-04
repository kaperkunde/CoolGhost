import {getClickHouse} from '../lib/clickhouse.js';
import type {GhostPipeName} from '../lib/jwt.js';
import {buildHitsFilter, queryString, type PipeQueryParams} from './filters.js';

export type {PipeQueryParams} from './filters.js';

type PipeHandler = (params: {
  siteUuid: string;
  query: PipeQueryParams;
}) => Promise<unknown>;

/** Tinybird-compatible envelope. */
function envelope(data: unknown[], statistics?: Record<string, unknown>) {
  return {
    meta: [{name: 'result', type: 'JSON'}],
    data,
    rows: data.length,
    statistics: statistics ?? {elapsed: 0, rows_read: 0, bytes_read: 0}
  };
}

function dateRangeDays(dateFrom: string, dateTo: string): string[] {
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  const days: string[] = [];
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

const kpis: PipeHandler = async ({siteUuid, query}) => {
  const dateFrom = queryString(query, 'date_from') ?? new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const dateTo = queryString(query, 'date_to') ?? new Date().toISOString().slice(0, 10);
  const memberStatus = queryString(query, 'member_status');

  let memberFilter = '';
  const statuses = memberStatus
    ? memberStatus.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const queryParams: Record<string, string | string[]> = {siteUuid, dateFrom, dateTo};

  if (statuses.length > 0) {
    memberFilter = 'AND member_status IN {statuses:Array(String)}';
    queryParams.statuses = statuses;
  }

  const ch = getClickHouse();
  const result = await ch.query({
    query: `
      SELECT
        date,
        uniqExact(session_id) AS visits,
        sum(session_pageviews) AS pageviews,
        round(avg(session_pageviews = 1), 2) AS bounce_rate,
        round(avg(session_sec), 2) AS avg_session_sec
      FROM (
        SELECT
          toDate(timestamp) AS date,
          session_id,
          count() AS session_pageviews,
          max(timestamp) - min(timestamp) AS session_sec
        FROM mv_hits
        WHERE site_uuid = {siteUuid:String}
          AND timestamp >= toDateTime({dateFrom:String})
          AND timestamp < toDateTime({dateTo:String}) + INTERVAL 1 DAY
          ${memberFilter}
        GROUP BY date, session_id
      )
      GROUP BY date
      ORDER BY date
    `,
    query_params: queryParams,
    format: 'JSONEachRow'
  });

  const rows = await result.json<{
    date: string;
    visits: string;
    pageviews: string;
    bounce_rate: string;
    avg_session_sec: string;
  }>();

  const byDate = new Map(
    rows.map((r) => [
      r.date.slice(0, 10),
      {
        date: r.date.slice(0, 10),
        visits: Number(r.visits),
        pageviews: Number(r.pageviews),
        bounce_rate: Number(r.bounce_rate),
        avg_session_sec: Number(r.avg_session_sec)
      }
    ])
  );

  const filled = dateRangeDays(dateFrom, dateTo).map((date) =>
    byDate.get(date) ?? {
      date,
      visits: 0,
      pageviews: 0,
      bounce_rate: 0,
      avg_session_sec: 0
    }
  );

  return envelope(filled);
};

const activeVisitors: PipeHandler = async ({siteUuid, query}) => {
  const ch = getClickHouse();
  const postUuid = typeof query.post_uuid === 'string' ? query.post_uuid : undefined;
  const result = await ch.query({
    query: `
      SELECT uniqExact(session_id) AS active_visitors
      FROM mv_hits
      WHERE site_uuid = {siteUuid:String}
        AND timestamp >= now() - INTERVAL 5 MINUTE
        ${postUuid ? 'AND post_uuid = {postUuid:String}' : ''}
    `,
    query_params: postUuid ? {siteUuid, postUuid} : {siteUuid},
    format: 'JSONEachRow'
  });
  const rows = await result.json<{active_visitors: string}>();
  const activeVisitorsCount = Number(rows[0]?.active_visitors ?? 0);
  return envelope([{active_visitors: activeVisitorsCount}]);
};

const topPages: PipeHandler = async ({siteUuid, query}) => {
  const {whereSql, queryParams, limit, skip} = buildHitsFilter(siteUuid, query);
  const ch = getClickHouse();
  const result = await ch.query({
    query: `
      SELECT
        if(post_uuid = 'undefined', '', post_uuid) AS post_uuid,
        pathname,
        uniqExact(session_id) AS visits
      FROM mv_hits
      WHERE ${whereSql}
      GROUP BY post_uuid, pathname
      ORDER BY visits DESC
      LIMIT {skip:UInt32}, {limit:UInt32}
    `,
    query_params: {...queryParams, skip, limit},
    format: 'JSONEachRow'
  });
  const rows = await result.json<{post_uuid: string; pathname: string; visits: string}>();
  return envelope(
    rows.map((r) => ({
      post_uuid: r.post_uuid,
      pathname: r.pathname,
      visits: Number(r.visits)
    }))
  );
};

const topSources: PipeHandler = async ({siteUuid, query}) => {
  const {whereSql, queryParams, limit, skip} = buildHitsFilter(siteUuid, query);
  const ch = getClickHouse();
  const result = await ch.query({
    query: `
      SELECT source, count() AS visits
      FROM (
        SELECT session_id, argMin(source, timestamp) AS source
        FROM mv_hits
        WHERE ${whereSql}
        GROUP BY session_id
      )
      GROUP BY source
      ORDER BY visits DESC
      LIMIT {skip:UInt32}, {limit:UInt32}
    `,
    query_params: {...queryParams, skip, limit},
    format: 'JSONEachRow'
  });
  const rows = await result.json<{source: string; visits: string}>();
  return envelope(rows.map((r) => ({source: r.source, visits: Number(r.visits)})));
};

const topLocations: PipeHandler = async ({siteUuid, query}) => {
  const {whereSql, queryParams, limit, skip} = buildHitsFilter(siteUuid, query);
  const ch = getClickHouse();
  const result = await ch.query({
    query: `
      SELECT location, uniqExact(session_id) AS visits
      FROM mv_hits
      WHERE ${whereSql}
      GROUP BY location
      ORDER BY visits DESC
      LIMIT {skip:UInt32}, {limit:UInt32}
    `,
    query_params: {...queryParams, skip, limit},
    format: 'JSONEachRow'
  });
  const rows = await result.json<{location: string; visits: string}>();
  return envelope(rows.map((r) => ({location: r.location, visits: Number(r.visits)})));
};

const handlers: Partial<Record<GhostPipeName, PipeHandler>> = {
  api_active_visitors: activeVisitors,
  api_active_visitors_v2: activeVisitors,
  api_kpis: kpis,
  api_kpis_v2: kpis,
  api_top_pages: topPages,
  api_top_pages_v2: topPages,
  api_top_sources: topSources,
  api_top_sources_v2: topSources,
  api_top_locations: topLocations,
  api_top_locations_v2: topLocations
};

const defaultHandler: PipeHandler = async () => envelope([]);

export async function runPipe(
  pipeName: GhostPipeName,
  siteUuid: string,
  query: PipeQueryParams
): Promise<unknown> {
  const handler = handlers[pipeName] ?? defaultHandler;
  return handler({siteUuid, query});
}

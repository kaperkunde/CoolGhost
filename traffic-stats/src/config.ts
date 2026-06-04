export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.LISTEN_HOST ?? '0.0.0.0',
  clickhouseUrl: process.env.CLICKHOUSE_URL ?? 'http://clickhouse:8123',
  clickhouseDatabase: process.env.CLICKHOUSE_DATABASE ?? 'ghost_analytics',
  tinybirdAdminToken: 'DUMMY_TOKEN',
  tinybirdWorkspaceId: 'DUMMY_WORKSPACE_ID',
  eventsDatasource: process.env.TINYBIRD_EVENTS_DATASOURCE ?? 'analytics_events'
};

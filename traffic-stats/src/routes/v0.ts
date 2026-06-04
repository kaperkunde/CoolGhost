import type {FastifyInstance} from 'fastify';
import {config} from '../config.js';
import {getClickHouse, pingClickHouse} from '../lib/clickhouse.js';
import {GHOST_PIPE_NAMES, verifyPipeToken, type GhostPipeName} from '../lib/jwt.js';
import {normalizeClickHouseDateTime} from '../lib/timestamp.js';
import {runPipe} from '../pipes/registry.js';

type AnalyticsEventRow = {
  timestamp: string;
  session_id: string;
  action: string;
  version: string;
  payload: string;
  site_uuid: string;
};

function parseEventLines(body: string): AnalyticsEventRow[] {
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean);
  const rows: AnalyticsEventRow[] = [];

  for (const line of lines) {
    const event = JSON.parse(line) as Record<string, unknown>;
    const payload = event.payload;
    const payloadStr =
      typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
    const siteUuid =
      (event.site_uuid as string | undefined) ??
      (JSON.parse(payloadStr) as {site_uuid?: string}).site_uuid ??
      '';

    rows.push({
      timestamp: normalizeClickHouseDateTime(event.timestamp),
      session_id: String(event.session_id ?? ''),
      action: String(event.action ?? 'page_hit'),
      version: String(event.version ?? '1'),
      payload: payloadStr,
      site_uuid: siteUuid
    });
  }

  return rows;
}

export async function registerV0Routes(app: FastifyInstance) {
  app.get('/v0/health', async (_req, reply) => {
    const ok = await pingClickHouse();
    if (!ok) {
      return reply.status(503).send({status: 'error', error: 'clickhouse unavailable'});
    }
    return {status: 'ok'};
  });

  app.post('/v0/events', async (req, reply) => {
    const name = (req.query as {name?: string}).name;
    if (name && name !== config.eventsDatasource) {
      return reply.status(400).send({error: `Unknown datasource: ${name}`});
    }

    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
    if (!body.trim()) {
      return reply.status(400).send({error: 'Empty body'});
    }

    let rows: AnalyticsEventRow[];
    try {
      rows = parseEventLines(body);
    } catch (err) {
      req.log.warn({err}, 'Invalid events payload');
      return reply.status(400).send({error: 'Invalid NDJSON'});
    }

    const ch = getClickHouse();
    await ch.insert({
      table: 'analytics_events',
      values: rows,
      format: 'JSONEachRow'
    });

    const wait = (req.query as {wait?: string}).wait === 'true';
    return reply.status(wait ? 200 : 202).send({
      successful_rows: rows.length,
      quarantined_rows: 0
    });
  });

  for (const pipe of GHOST_PIPE_NAMES) {
    app.get(`/v0/pipes/${pipe}.json`, async (req, reply) => {
      const query = req.query as {token?: string};
      const check = verifyPipeToken(req.headers.authorization, query.token, pipe);

      if (!check.ok) {
        return reply.status(403).send({error: check.error});
      }

      try {
        const result = await runPipe(
          pipe as GhostPipeName,
          check.siteUuid!,
          req.query as Record<string, string | string[] | undefined>
        );
        return result;
      } catch (err) {
        req.log.error({err, pipe}, 'Pipe query failed');
        return reply.status(500).send({error: 'Pipe execution failed'});
      }
    });
  }
}

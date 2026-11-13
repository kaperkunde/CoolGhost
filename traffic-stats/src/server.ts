import Fastify from 'fastify';
import {ConfigError, loadConfig, type Config} from './config.js';
import {initClickHouse} from './lib/clickhouse.js';
import {createPipeTokenVerifier} from './lib/jwt.js';
import {createSiteLookup} from './lib/site-lookup.js';
import {registerV0Routes} from './routes/v0.js';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`traffic-stats will not start: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (config.allowLegacyToken) {
  console.warn(
    'traffic-stats: STATS_ALLOW_LEGACY_DUMMY_TOKEN is on, so tokens signed with DUMMY_TOKEN are still accepted.'
  );
}

initClickHouse(config);

const verifyPipeToken = createPipeTokenVerifier({
  config,
  lookupSite: config.siteLookupUrl
    ? createSiteLookup({url: config.siteLookupUrl, token: config.siteLookupToken})
    : null
});

const app = Fastify({
  logger: true,
  trustProxy: process.env.TRUST_PROXY !== 'false'
});

app.get('/', async () => ({
  service: 'traffic-stats',
  tinybird_api: '/v0'
}));

await registerV0Routes(app, {config, verifyPipeToken});

try {
  await app.listen({port: config.port, host: config.host});
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

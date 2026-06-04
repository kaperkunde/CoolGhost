import Fastify from 'fastify';
import {config} from './config.js';
import {registerV0Routes} from './routes/v0.js';

const app = Fastify({
  logger: true,
  trustProxy: process.env.TRUST_PROXY !== 'false'
});

app.get('/', async () => ({
  service: 'traffic-stats',
  tinybird_api: '/v0'
}));

await registerV0Routes(app);

try {
  await app.listen({port: config.port, host: config.host});
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

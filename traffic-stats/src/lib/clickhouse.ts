import {createClient, type ClickHouseClient} from '@clickhouse/client';
import type {Config} from '../config.js';

let client: ClickHouseClient | null = null;

export function initClickHouse(
  config: Pick<Config, 'clickhouseUrl' | 'clickhouseDatabase' | 'clickhouseUser' | 'clickhousePassword'>
): void {
  client = createClient({
    url: config.clickhouseUrl,
    database: config.clickhouseDatabase,
    username: config.clickhouseUser,
    password: config.clickhousePassword,
    clickhouse_settings: {
      async_insert: 1,
      wait_for_async_insert: 1
    }
  });
}

export function getClickHouse(): ClickHouseClient {
  if (!client) {
    throw new Error('ClickHouse client not initialised');
  }
  return client;
}

export async function pingClickHouse(): Promise<boolean> {
  try {
    const result = await getClickHouse().ping();
    return result.success;
  } catch {
    return false;
  }
}

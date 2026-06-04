import {createClient, type ClickHouseClient} from '@clickhouse/client';
import {config} from '../config.js';

let client: ClickHouseClient | null = null;

export function getClickHouse(): ClickHouseClient {
  if (!client) {
    client = createClient({
      url: config.clickhouseUrl,
      database: config.clickhouseDatabase,
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1
      }
    });
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

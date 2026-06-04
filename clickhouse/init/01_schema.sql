CREATE DATABASE IF NOT EXISTS ghost_analytics;

CREATE TABLE IF NOT EXISTS ghost_analytics.analytics_events
(
    timestamp DateTime,
    session_id String,
    action LowCardinality(String),
    version LowCardinality(String),
    payload String,
    site_uuid LowCardinality(String),
    inserted_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (site_uuid, timestamp);

CREATE TABLE IF NOT EXISTS ghost_analytics.mv_hits
(
    site_uuid LowCardinality(String),
    timestamp DateTime,
    received_at DateTime64(3),
    inserted_at DateTime64(3),
    ingestion_latency_ms Int64,
    action LowCardinality(String),
    version LowCardinality(String),
    session_id String,
    member_uuid String,
    member_status String,
    post_uuid String,
    post_type String,
    location String,
    source String,
    pathname String,
    href String,
    device String,
    os String,
    browser String,
    utm_source String,
    utm_medium String,
    utm_campaign String,
    utm_term String,
    utm_content String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (site_uuid, timestamp, session_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS ghost_analytics.mv_hits_mv TO ghost_analytics.mv_hits AS
SELECT
    site_uuid,
    timestamp,
    parseDateTime64BestEffortOrZero(JSONExtractString(payload, 'meta', 'received_timestamp'), 3) AS received_at,
    inserted_at,
    if(
        toUnixTimestamp(parseDateTime64BestEffortOrZero(JSONExtractString(payload, 'meta', 'received_timestamp'), 3)) = 0,
        -1,
        dateDiff('millisecond', parseDateTime64BestEffortOrZero(JSONExtractString(payload, 'meta', 'received_timestamp'), 3), inserted_at)
    ) AS ingestion_latency_ms,
    action,
    version,
    coalesce(session_id, '0') AS session_id,
    JSONExtractString(payload, 'member_uuid') AS member_uuid,
    JSONExtractString(payload, 'member_status') AS member_status,
    JSONExtractString(payload, 'post_uuid') AS post_uuid,
    JSONExtractString(payload, 'post_type') AS post_type,
    JSONExtractString(payload, 'location') AS location,
    coalesce(
        nullIf(JSONExtractString(payload, 'referrerSource'), ''),
        nullIf(JSONExtractString(payload, 'meta', 'referrerSource'), ''),
        ''
    ) AS source,
    JSONExtractString(payload, 'pathname') AS pathname,
    JSONExtractString(payload, 'href') AS href,
    if(JSONExtractString(payload, 'device') = '', 'unknown', JSONExtractString(payload, 'device')) AS device,
    'Unknown' AS os,
    'Unknown' AS browser,
    JSONExtractString(payload, 'utm_source') AS utm_source,
    JSONExtractString(payload, 'utm_medium') AS utm_medium,
    JSONExtractString(payload, 'utm_campaign') AS utm_campaign,
    JSONExtractString(payload, 'utm_term') AS utm_term,
    JSONExtractString(payload, 'utm_content') AS utm_content
FROM ghost_analytics.analytics_events
WHERE action = 'page_hit';

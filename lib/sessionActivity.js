"use strict";

const SESSION_ACTIVITY_REFRESH_MS = 5 * 60 * 1000;

const ALLOWED_SESSION_ACTIVITY_TABLES = new Set([
  "monitoring_sessions",
  "customer_sessions"
]);

function sessionActivityNeedsRefresh(lastUsedAt, now = Date.now()) {
  if (!lastUsedAt) return true;

  const lastUsedMs = new Date(lastUsedAt).getTime();
  if (!Number.isFinite(lastUsedMs)) return true;

  return now - lastUsedMs >= SESSION_ACTIVITY_REFRESH_MS;
}

function touchSessionActivityBestEffort({
  pool,
  tableName,
  tokenHash,
  lastUsedAt,
  logger = console
}) {
  if (!sessionActivityNeedsRefresh(lastUsedAt)) {
    return false;
  }

  if (!ALLOWED_SESSION_ACTIVITY_TABLES.has(tableName)) {
    throw new Error(`Unsupported session activity table: ${tableName}`);
  }

  Promise.resolve()
    .then(() =>
      pool.query(
        `UPDATE ${tableName}
         SET last_used_at = NOW()
         WHERE token_hash = $1
           AND (
             last_used_at IS NULL
             OR last_used_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond')
           )`,
        [tokenHash, SESSION_ACTIVITY_REFRESH_MS]
      )
    )
    .catch((error) => {
    logger.warn?.(
      `Session activity update failed for ${tableName}:`,
      error?.message || String(error)
    );
  });

  return true;
}

module.exports = {
  SESSION_ACTIVITY_REFRESH_MS,
  sessionActivityNeedsRefresh,
  touchSessionActivityBestEffort
};

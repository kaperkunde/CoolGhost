import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

/** Workspace ids that can have a derived key: a database-name-like identifier. */
export const DERIVED_WORKSPACE_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * The signing secret for one workspace, derived from a master key, for hosts
 * that serve many Ghost sites from one traffic-stats. Each site's Ghost gets
 * its own value as `tinybird__adminToken` (with the workspace id as
 * `tinybird__workspaceId`), and traffic-stats derives it again to verify.
 *
 * The `gs1_` prefix keeps the value a string when Ghost reads it from the
 * environment (nconf parses values, and a bare number would break signing).
 */
export function deriveSiteKey(masterKey: string, workspaceId: string): string {
  if (!DERIVED_WORKSPACE_PATTERN.test(workspaceId)) {
    throw new Error('Invalid workspace id');
  }
  const mac = createHmac('sha256', masterKey).update(`ghost-stats-v1:${workspaceId}`).digest('base64url');
  return `gs1_${mac}`;
}

/** Constant-time comparison of two secrets of any length. */
export function secretsMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Whether an Authorization header carries `Bearer <expected>`. */
export function bearerMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith('Bearer ')) {
    return false;
  }
  return secretsMatch(authorization.slice(7).trim(), expected);
}

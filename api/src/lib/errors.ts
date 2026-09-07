/**
 * Marks an error message as safe to show to the plekje owner as-is (no host
 * paths, container names, env var names, or other deploy-internal detail).
 * Everything else that fails a data job or route is logged in full server
 * side but replaced with a generic message before it reaches the client —
 * see data-jobs.ts and routes/data.ts.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UserFacingError"
  }
}

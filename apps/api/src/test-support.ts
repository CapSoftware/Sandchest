/** Integration-style API suites are opt-in so the default `bun test` run stays stable. */
export const RUN_API_INTEGRATION_TESTS = process.env['RUN_API_INTEGRATION_TESTS'] === '1'

/** Database integration suites also need a configured database URL. */
export const RUN_API_DB_INTEGRATION_TESTS =
  RUN_API_INTEGRATION_TESTS && Boolean(process.env['DATABASE_URL'])

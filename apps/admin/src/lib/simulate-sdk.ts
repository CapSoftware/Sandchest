import { Sandchest } from '@sandchest/sdk'

export function createClient(apiKey: string, baseUrl: string): Sandchest {
  return new Sandchest({
    apiKey,
    baseUrl,
    timeout: 60_000,
    retries: 1,
  })
}

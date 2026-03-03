const FLY_GRAPHQL_URL = 'https://api.fly.io/graphql'

/**
 * Set secrets on a Fly.io app via the GraphQL API.
 * Triggers a new release so the app restarts with the updated secrets.
 */
export async function setFlySecrets(
  appName: string,
  secrets: Record<string, string>,
  token: string,
): Promise<void> {
  const secretsInput = Object.entries(secrets).map(([key, value]) => ({
    key,
    value,
  }))

  const res = await fetch(FLY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: `
        mutation SetSecrets($input: SetSecretsInput!) {
          setSecrets(input: $input) {
            release { id version }
          }
        }
      `,
      variables: {
        input: {
          appId: appName,
          secrets: secretsInput,
        },
      },
    }),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Fly API returned ${res.status}: ${text.slice(0, 200)}`)
  }

  const data = (await res.json()) as { errors?: { message: string }[] }
  if (data.errors?.length) {
    throw new Error(`Fly API error: ${data.errors[0]!.message}`)
  }
}

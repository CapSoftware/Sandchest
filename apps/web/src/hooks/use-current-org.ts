'use client'

import { useParams } from 'next/navigation'
import { useOrgs } from './use-orgs'
import type { Org } from './use-orgs'

export interface CurrentOrgResult {
  org: Org | undefined
  isLoading: boolean
  error: Error | null
}

export function useCurrentOrg(): CurrentOrgResult {
  const params = useParams<{ orgSlug: string }>()
  const { data: orgs, isPending, error } = useOrgs()

  const org = orgs?.find((o) => o.slug === params.orgSlug)

  return {
    org,
    isLoading: isPending,
    error: error as Error | null,
  }
}

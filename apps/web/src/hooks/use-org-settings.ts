'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { authClient } from '@/lib/auth-client'

interface OrgData {
  id: string
  name: string
  slug: string
  createdAt: Date
}

interface OrgMember {
  id: string
  userId: string
  role: string
  user: {
    name: string
    email: string
  }
}

interface FullOrg {
  org: OrgData
  members: OrgMember[]
}

const orgSettingsKeys = {
  all: ['orgSettings'] as const,
  full: () => [...orgSettingsKeys.all, 'full'] as const,
}

export function useOrgSettings() {
  return useQuery({
    queryKey: orgSettingsKeys.full(),
    queryFn: async (): Promise<FullOrg> => {
      const { data, error } =
        await authClient.organization.getFullOrganization()
      if (error)
        throw new Error(error.message ?? 'Failed to load organization')
      const raw = data as unknown as OrgData & { members: OrgMember[] }
      return {
        org: {
          id: raw.id,
          name: raw.name,
          slug: raw.slug,
          createdAt: raw.createdAt,
        },
        members: raw.members ?? [],
      }
    },
  })
}

export function useUpdateOrgName() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (name: string) => {
      const { error } = await authClient.organization.update({
        data: { name },
      })
      if (error)
        throw new Error(error.message ?? 'Failed to update organization')
    },
    onMutate: async (name) => {
      await queryClient.cancelQueries({ queryKey: orgSettingsKeys.full() })

      const previous = queryClient.getQueryData<FullOrg>(
        orgSettingsKeys.full(),
      )

      queryClient.setQueryData<FullOrg>(orgSettingsKeys.full(), (old) =>
        old ? { ...old, org: { ...old.org, name } } : old,
      )

      return { previous }
    },
    onError: (_err, _name, context) => {
      if (context?.previous) {
        queryClient.setQueryData(orgSettingsKeys.full(), context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orgSettingsKeys.full() })
    },
  })
}

export function useInviteMember() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      email,
      role,
    }: {
      email: string
      role: 'member' | 'admin'
    }) => {
      const { error } = await authClient.organization.inviteMember({
        email,
        role,
      })
      if (error) throw new Error(error.message ?? 'Failed to send invite')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orgSettingsKeys.full() })
    },
  })
}

export function useRemoveMember() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (memberId: string) => {
      const { error } = await authClient.organization.removeMember({
        memberIdOrEmail: memberId,
      })
      if (error) throw new Error(error.message ?? 'Failed to remove member')
    },
    onMutate: async (memberId) => {
      await queryClient.cancelQueries({ queryKey: orgSettingsKeys.full() })

      const previous = queryClient.getQueryData<FullOrg>(
        orgSettingsKeys.full(),
      )

      queryClient.setQueryData<FullOrg>(orgSettingsKeys.full(), (old) =>
        old
          ? {
              ...old,
              members: old.members.filter((m) => m.id !== memberId),
            }
          : old,
      )

      return { previous }
    },
    onError: (_err, _memberId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(orgSettingsKeys.full(), context.previous)
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: orgSettingsKeys.full() })
    },
  })
}

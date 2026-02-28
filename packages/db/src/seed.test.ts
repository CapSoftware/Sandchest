import { describe, test, expect } from 'bun:test'
import { PROFILE_IDS, IMAGE_IDS, DEV_NODE_ID } from './seed.js'

describe('seed', () => {
  // -- Well-known IDs --------------------------------------------------------

  describe('PROFILE_IDS', () => {
    test('has small, medium, large entries', () => {
      expect(PROFILE_IDS.small).toBeInstanceOf(Uint8Array)
      expect(PROFILE_IDS.medium).toBeInstanceOf(Uint8Array)
      expect(PROFILE_IDS.large).toBeInstanceOf(Uint8Array)
    })

    test('all IDs are 16 bytes (BINARY(16))', () => {
      expect(PROFILE_IDS.small.length).toBe(16)
      expect(PROFILE_IDS.medium.length).toBe(16)
      expect(PROFILE_IDS.large.length).toBe(16)
    })

    test('all IDs are unique', () => {
      const asStrings = [PROFILE_IDS.small, PROFILE_IDS.medium, PROFILE_IDS.large].map((id) =>
        Array.from(id).join(','),
      )
      expect(new Set(asStrings).size).toBe(3)
    })

    test('IDs are non-zero', () => {
      for (const id of [PROFILE_IDS.small, PROFILE_IDS.medium, PROFILE_IDS.large]) {
        expect(id.some((b) => b !== 0)).toBe(true)
      }
    })
  })

  describe('IMAGE_IDS', () => {
    test('has ubuntu-22.04/base entry', () => {
      expect(IMAGE_IDS['ubuntu-22.04/base']).toBeInstanceOf(Uint8Array)
    })

    test('ID is 16 bytes', () => {
      expect(IMAGE_IDS['ubuntu-22.04/base'].length).toBe(16)
    })

    test('ID is distinct from all profile IDs', () => {
      const imageStr = Array.from(IMAGE_IDS['ubuntu-22.04/base']).join(',')
      for (const profileId of Object.values(PROFILE_IDS)) {
        expect(Array.from(profileId).join(',')).not.toBe(imageStr)
      }
    })
  })

  describe('DEV_NODE_ID', () => {
    test('is 16 bytes', () => {
      expect(DEV_NODE_ID).toBeInstanceOf(Uint8Array)
      expect(DEV_NODE_ID.length).toBe(16)
    })

    test('is distinct from profile and image IDs', () => {
      const nodeStr = Array.from(DEV_NODE_ID).join(',')
      for (const profileId of Object.values(PROFILE_IDS)) {
        expect(Array.from(profileId).join(',')).not.toBe(nodeStr)
      }
      expect(Array.from(IMAGE_IDS['ubuntu-22.04/base']).join(',')).not.toBe(nodeStr)
    })
  })

  // -- Module exports --------------------------------------------------------

  describe('module exports', () => {
    test('exports seed function', async () => {
      const mod = await import('./seed.js')
      expect(typeof mod.seed).toBe('function')
    })

    test('exports seedDev function', async () => {
      const mod = await import('./seed.js')
      expect(typeof mod.seedDev).toBe('function')
    })

    test('exports PROFILE_IDS', async () => {
      const mod = await import('./seed.js')
      expect(mod.PROFILE_IDS).toBeDefined()
      expect(Object.keys(mod.PROFILE_IDS)).toEqual(['small', 'medium', 'large'])
    })

    test('exports IMAGE_IDS', async () => {
      const mod = await import('./seed.js')
      expect(mod.IMAGE_IDS).toBeDefined()
      expect(Object.keys(mod.IMAGE_IDS)).toEqual(['ubuntu-22.04/base'])
    })

    test('exports DEV_NODE_ID', async () => {
      const mod = await import('./seed.js')
      expect(mod.DEV_NODE_ID).toBeInstanceOf(Uint8Array)
    })
  })

  // -- ID stability ----------------------------------------------------------

  describe('ID stability', () => {
    test('profile IDs match expected byte patterns', () => {
      // These IDs are referenced by integration tests and must not change
      expect(Array.from(PROFILE_IDS.small)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
      expect(Array.from(PROFILE_IDS.medium)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2])
      expect(Array.from(PROFILE_IDS.large)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3])
    })

    test('image ID matches expected byte pattern', () => {
      expect(Array.from(IMAGE_IDS['ubuntu-22.04/base'])).toEqual([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0,
      ])
    })

    test('dev node ID matches expected byte pattern', () => {
      expect(Array.from(DEV_NODE_ID)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0])
    })
  })
})

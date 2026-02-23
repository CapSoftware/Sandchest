import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const LANDING_DIR = import.meta.dir

function read(filename: string): string {
  return readFileSync(join(LANDING_DIR, filename), 'utf-8')
}

function isClientComponent(src: string): boolean {
  return src.trimStart().startsWith("'use client'")
}

function usesHook(src: string, hook: string): boolean {
  return new RegExp(`\\b${hook}\\b`).test(src)
}

describe('landing page server/client component boundaries', () => {
  describe('server components have no use client directive', () => {
    const serverComponents = ['Nav.tsx', 'Hero.tsx', 'BentoGrid.tsx', 'Cta.tsx', 'CodeExample.tsx']

    for (const file of serverComponents) {
      test(file, () => {
        const src = read(file)
        expect(isClientComponent(src)).toBe(false)
      })
    }
  })

  describe('client components have use client directive', () => {
    const clientComponents = ['MobileMenu.tsx', 'InstallCommand.tsx', 'BentoCell.tsx', 'CtaAnimation.tsx', 'ScrollReveal.tsx']

    for (const file of clientComponents) {
      test(file, () => {
        const src = read(file)
        expect(isClientComponent(src)).toBe(true)
      })
    }
  })

  describe('server components do not use React hooks', () => {
    const serverComponents = ['Nav.tsx', 'Hero.tsx', 'BentoGrid.tsx', 'Cta.tsx', 'CodeExample.tsx']
    const hooks = ['useState', 'useEffect', 'useRef', 'useCallback', 'useMemo']

    for (const file of serverComponents) {
      test(file, () => {
        const src = read(file)
        for (const hook of hooks) {
          expect(usesHook(src, hook)).toBe(false)
        }
      })
    }
  })

  describe('server components import their client children', () => {
    test('Nav imports MobileMenu', () => {
      const src = read('Nav.tsx')
      expect(src).toContain("import MobileMenu from './MobileMenu'")
      expect(src).toContain('<MobileMenu')
    })

    test('Hero imports InstallCommand', () => {
      const src = read('Hero.tsx')
      expect(src).toContain("import InstallCommand from './InstallCommand'")
      expect(src).toContain('<InstallCommand')
    })

    test('BentoGrid imports BentoCell', () => {
      const src = read('BentoGrid.tsx')
      expect(src).toContain("import BentoCell from './BentoCell'")
      expect(src).toContain('<BentoCell')
    })

    test('Cta imports CtaAnimation', () => {
      const src = read('Cta.tsx')
      expect(src).toContain("import CtaAnimation from './CtaAnimation'")
      expect(src).toContain('<CtaAnimation')
    })
  })

  describe('client components use only necessary hooks', () => {
    test('MobileMenu uses useState for toggle', () => {
      const src = read('MobileMenu.tsx')
      expect(usesHook(src, 'useState')).toBe(true)
      expect(usesHook(src, 'useEffect')).toBe(false)
    })

    test('InstallCommand uses useState and useRef', () => {
      const src = read('InstallCommand.tsx')
      expect(usesHook(src, 'useState')).toBe(true)
      expect(usesHook(src, 'useRef')).toBe(true)
      expect(usesHook(src, 'useEffect')).toBe(false)
    })

    test('BentoCell uses useEffect and useRef for canvas', () => {
      const src = read('BentoCell.tsx')
      expect(usesHook(src, 'useEffect')).toBe(true)
      expect(usesHook(src, 'useRef')).toBe(true)
      expect(usesHook(src, 'useState')).toBe(false)
    })

    test('CtaAnimation uses useEffect and useRef for canvas', () => {
      const src = read('CtaAnimation.tsx')
      expect(usesHook(src, 'useEffect')).toBe(true)
      expect(usesHook(src, 'useRef')).toBe(true)
      expect(usesHook(src, 'useState')).toBe(false)
    })

    test('ScrollReveal uses useEffect and useRef for observer', () => {
      const src = read('ScrollReveal.tsx')
      expect(usesHook(src, 'useEffect')).toBe(true)
      expect(usesHook(src, 'useRef')).toBe(true)
      expect(usesHook(src, 'useState')).toBe(false)
    })
  })

  describe('static content stays in server components', () => {
    test('Nav contains static nav links', () => {
      const src = read('Nav.tsx')
      expect(src).toContain('What is Sandchest?')
      expect(src).toContain('See it in action')
      expect(src).toContain('Pricing')
      expect(src).toContain('Star on GitHub')
    })

    test('Hero contains heading and steps', () => {
      const src = read('Hero.tsx')
      expect(src).toContain('The sandbox platform for AI agents.')
      expect(src).toContain('How it works')
      expect(src).toContain('Add Sandchest to your agent')
    })

    test('BentoGrid contains feature data and section header', () => {
      const src = read('BentoGrid.tsx')
      expect(src).toContain('Sub-100ms forking')
      expect(src).toContain('VM-grade isolation')
      expect(src).toContain('TypeScript SDK')
      expect(src).toContain('What is Sandchest?')
    })

    test('Cta contains text content and links', () => {
      const src = read('Cta.tsx')
      expect(src).toContain('Follow along')
      expect(src).toContain('Star on GitHub')
      expect(src).toContain('View Repository')
    })
  })

  describe('interactive content lives in client components', () => {
    test('MobileMenu has toggle and close handlers', () => {
      const src = read('MobileMenu.tsx')
      expect(src).toContain('toggleMenu')
      expect(src).toContain('closeMenu')
      expect(src).toContain('aria-expanded')
    })

    test('InstallCommand has package manager tabs and copy', () => {
      const src = read('InstallCommand.tsx')
      expect(src).toContain('activePkg')
      expect(src).toContain('handleCopy')
      expect(src).toContain('navigator.clipboard')
    })

    test('BentoCell has canvas animation init', () => {
      const src = read('BentoCell.tsx')
      expect(src).toContain('requestAnimationFrame')
      expect(src).toContain('cancelAnimationFrame')
      expect(src).toContain('createCanvas')
    })

    test('CtaAnimation has canvas animation with particles', () => {
      const src = read('CtaAnimation.tsx')
      expect(src).toContain('requestAnimationFrame')
      expect(src).toContain('cancelAnimationFrame')
      expect(src).toContain('particles')
    })
  })
})

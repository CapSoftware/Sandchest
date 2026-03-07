import { setDefaultResultOrder } from 'node:dns'

setDefaultResultOrder('ipv4first')

const realFetch = globalThis.fetch.bind(globalThis)

Object.defineProperty(globalThis, '__sandchestRealFetch', {
  value: realFetch,
  writable: false,
  configurable: true,
})

globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  return Promise.reject(new Error(`Unexpected network request during tests: ${target}`))
}) as typeof fetch

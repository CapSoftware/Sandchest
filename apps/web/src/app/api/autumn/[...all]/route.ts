import { autumnHandler } from 'autumn-js/next'
import { identify } from './identify'

export const { GET, POST } = autumnHandler({ identify })

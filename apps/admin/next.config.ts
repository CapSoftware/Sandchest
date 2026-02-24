import { config } from 'dotenv'
import type { NextConfig } from 'next'

config({ path: '../../.env' })

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sandchest/contract', '@sandchest/db'],
}

export default nextConfig

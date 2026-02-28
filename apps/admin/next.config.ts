import { config } from 'dotenv'
import type { NextConfig } from 'next'

config({ path: '../../.env' })

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sandchest/contract', '@sandchest/db'],
  serverExternalPackages: ['ssh2', 'cpu-features'],
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}

export default nextConfig

import { config } from 'dotenv'
import type { NextConfig } from 'next'

config({ path: '../../.env' })

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@sandchest/contract'],
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/:path*',
          has: [{ type: 'host', value: 'app.sandchest.com' }],
          destination: '/dashboard/:path*',
        },
      ],
    }
  },
}

export default nextConfig

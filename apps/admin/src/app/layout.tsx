import type { Metadata } from 'next'
import Providers from '@/components/Providers'
import '@/styles/global.css'

export const metadata: Metadata = {
  title: 'Sandchest Admin',
  description: 'Infrastructure management dashboard',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <head>
        <link
          rel="preload"
          href="/fonts/GeistMono-Variable.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}

import type { Metadata } from 'next'
import '@/styles/global.css'

export const metadata: Metadata = {
  title: 'Sandchest — The sandbox platform for AI agents',
  description:
    'Give your agents undo. Every sandbox is an isolated Linux VM that can be forked in sub-100ms.',
  openGraph: {
    title: 'Sandchest — The sandbox platform for AI agents',
    description:
      'Give your agents undo. Every sandbox is an isolated Linux VM that can be forked in sub-100ms.',
    images: ['/og.png'],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Sandchest — The sandbox platform for AI agents',
    description:
      'Give your agents undo. Every sandbox is an isolated Linux VM that can be forked in sub-100ms.',
    images: ['/og.png'],
  },
  icons: {
    icon: [
      { url: '/favicon.svg', type: 'image/svg+xml' },
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: '/apple-touch-icon.png',
  },
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
      <body>{children}</body>
    </html>
  )
}

import { Command } from 'commander'
import { readConfig } from '../../config.js'
import { header, table, info } from '../../output.js'

export function dnsShowCommand(): Command {
  return new Command('show')
    .description('Print required Cloudflare DNS records')
    .action(() => {
      const config = readConfig()
      const flyApp = config.fly?.appName ?? 'sandchest-api'
      const hetznerHost = config.hetzner?.host ?? '<HETZNER_IP>'
      const grpcPort = config.node?.grpcPort ?? 50051

      header('Required Cloudflare DNS Records')
      info('Set all records to DNS-only mode (grey cloud) — Fly.io and direct gRPC handle TLS.\n')

      table([
        ['Type', 'Name', 'Content', 'Proxy', 'Notes'],
        ['────', '────', '───────', '─────', '─────'],
        ['CNAME', 'api', `${flyApp}.fly.dev`, 'OFF', 'API endpoint (Fly.io handles TLS)'],
        ['A', 'node', hetznerHost, 'OFF', `gRPC endpoint (port ${grpcPort})`],
        ['CNAME', 'www', 'sandchest.com', 'OFF', 'Redirect to apex (optional)'],
      ])

      console.log()
      info('After adding records, verify with:')
      info('  dig api.sandchest.com +short')
      info('  dig node.sandchest.com +short')
    })
}

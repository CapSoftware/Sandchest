import { competitors } from '@/data/pricing'
import type { Competitor } from '@/data/pricing'

type FeatureKey = keyof Competitor['features']

const FEATURES: Array<{ name: string; key: FeatureKey }> = [
  { name: 'Session replay', key: 'sessionReplay' },
  { name: 'Sub-100ms forking', key: 'subSecondForking' },
  { name: 'MCP server', key: 'mcpServer' },
  { name: 'CLI with SSH', key: 'cliWithSsh' },
  { name: 'VM-grade isolation', key: 'vmIsolation' },
  { name: 'TypeScript SDK', key: 'typescriptSdk' },
]

function Check() {
  return (
    <svg className="h-4 w-4 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function Cross() {
  return (
    <svg className="h-4 w-4 text-text-weak" style={{ opacity: 0.4 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export default function FeatureGrid() {
  return (
    <div className="section">
      <div className="section-header">
        <h3 className="section-title">Beyond compute</h3>
        <p className="text-text-weak" style={{ fontSize: 13 }}>
          What you get with each provider &mdash; beyond raw sandbox hours.
        </p>
      </div>
      <div className="compare-table-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <th>Feature</th>
              <th>{competitors.e2b.name}</th>
              <th>{competitors.daytona.name}</th>
              <th className="compare-highlight-col">Sandchest</th>
            </tr>
          </thead>
          <tbody>
            {FEATURES.map((f) => (
              <tr key={f.name}>
                <td className="compare-row-label">{f.name}</td>
                <td>{competitors.e2b.features[f.key] ? <Check /> : <Cross />}</td>
                <td>{competitors.daytona.features[f.key] ? <Check /> : <Cross />}</td>
                <td className="compare-highlight-col"><Check /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

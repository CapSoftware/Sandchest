import { competitors, SANDCHEST_TIERS, sandboxPerHr, freePlan, paidPlan } from '@/data/pricing'

const e2b = competitors.e2b
const daytona = competitors.daytona
const free = SANDCHEST_TIERS.free
const max = SANDCHEST_TIERS.max

const e2bHobby = freePlan(e2b)
const e2bPro = paidPlan(e2b)
const daytonaFree = freePlan(daytona)

function fmtRate(n: number) {
  return '$' + n.toFixed(4)
}

export default function PricingCompare() {
  const compSmall = sandboxPerHr(e2b.rates.vcpuPerHr, e2b.rates.ramGiBPerHr)
  const scFreeSmall = sandboxPerHr(free.vcpuPerHr, free.ramGiBPerHr)
  const scMaxSmall = sandboxPerHr(max.vcpuPerHr, max.ramGiBPerHr)

  return (
    <div className="section">
      <div className="section-header" style={{ textAlign: 'center' }}>
        <h3 className="section-title">How we compare</h3>
        <p className="text-text-weak" style={{ fontSize: 13 }}>
          E2B and Daytona share the same per-unit compute rates. The real differences are in platform fees, credits, storage, and limits.
        </p>
      </div>
      <div className="compare-table-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <th />
              <th>{e2b.name}</th>
              <th>{daytona.name}</th>
              <th className="compare-highlight-col">Sandchest</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="compare-row-label">Sandbox (2v/4G) / hr</td>
              <td>{fmtRate(compSmall)}</td>
              <td>{fmtRate(compSmall)}</td>
              <td className="compare-highlight-col">{fmtRate(scMaxSmall)}&ndash;{fmtRate(scFreeSmall)}</td>
            </tr>
            <tr>
              <td className="compare-row-label">Platform fee</td>
              <td>$0 / ${e2bPro?.monthlyPrice}/mo</td>
              <td>$0</td>
              <td className="compare-highlight-col">$0 / ${max.monthlyBase}/mo</td>
            </tr>
            <tr>
              <td className="compare-row-label">Storage</td>
              <td>Included ({e2bHobby.storageFreeGiB}&ndash;{e2bPro?.storageFreeGiB ?? e2bHobby.storageFreeGiB} GiB)</td>
              <td>${daytona.rates.storageGiBPerHr?.toFixed(6)}/GiB/hr ({daytonaFree.storageFreeGiB} GiB free)</td>
              <td className="compare-highlight-col">Included</td>
            </tr>
            <tr>
              <td className="compare-row-label">Free credits</td>
              <td>${e2b.freeCredits.amount} one-time</td>
              <td>${daytona.freeCredits.amount} one-time</td>
              <td className="compare-highlight-col">${free.monthlyCredits}&ndash;{max.monthlyCredits}/mo recurring</td>
            </tr>
            <tr>
              <td className="compare-row-label">Max session</td>
              <td>{e2bHobby.maxSessionHours}&ndash;{e2bPro?.maxSessionHours} hours</td>
              <td>No limit</td>
              <td className="compare-highlight-col">{free.maxSessionHours}&ndash;{max.maxSessionHours} hours</td>
            </tr>
            <tr>
              <td className="compare-row-label">Max concurrent</td>
              <td>{e2bHobby.maxConcurrent}&ndash;{e2bPro?.maxConcurrent}</td>
              <td>No limit</td>
              <td className="compare-highlight-col">{free.maxConcurrent}&ndash;{max.maxConcurrent}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

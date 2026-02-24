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

export default function CompareTable() {
  const compSmall = sandboxPerHr(e2b.rates.vcpuPerHr, e2b.rates.ramGiBPerHr)
  const scFreeSmall = sandboxPerHr(free.vcpuPerHr, free.ramGiBPerHr)
  const scMaxSmall = sandboxPerHr(max.vcpuPerHr, max.ramGiBPerHr)

  return (
    <div className="section">
      <div className="section-header">
        <h3 className="section-title">Full pricing breakdown</h3>
        <p className="text-text-weak" style={{ fontSize: 13 }}>
          E2B and Daytona share the same per-unit compute rates. The real differences are in platform fees, credits, and limits.
        </p>
      </div>
      <div className="compare-table-wrap">
        <table className="compare-table">
          <thead>
            <tr>
              <th />
              <th>{e2b.name}</th>
              <th>{daytona.name}</th>
              <th className="compare-highlight-col">Sandchest Free</th>
              <th className="compare-highlight-col">Sandchest Max</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="compare-row-label">Sandbox (2v/4G) / hr</td>
              <td>{fmtRate(compSmall)}</td>
              <td>{fmtRate(compSmall)}</td>
              <td className="compare-highlight-col">{fmtRate(scFreeSmall)}</td>
              <td className="compare-highlight-col">{fmtRate(scMaxSmall)}</td>
            </tr>
            <tr>
              <td className="compare-row-label">Platform fee</td>
              <td>$0 (Hobby) / ${e2bPro?.monthlyPrice}/mo (Pro)</td>
              <td>$0</td>
              <td className="compare-highlight-col">$0</td>
              <td className="compare-highlight-col">${max.monthlyBase}/mo</td>
            </tr>
            <tr>
              <td className="compare-row-label">Storage</td>
              <td>Included ({e2bHobby.storageFreeGiB}&ndash;{e2bPro?.storageFreeGiB ?? e2bHobby.storageFreeGiB} GiB)</td>
              <td>${daytona.rates.storageGiBPerHr?.toFixed(6)}/GiB/hr ({daytonaFree.storageFreeGiB} GiB free)</td>
              <td className="compare-highlight-col">Included</td>
              <td className="compare-highlight-col">Included</td>
            </tr>
            <tr>
              <td className="compare-row-label">Free credits</td>
              <td>${e2b.freeCredits.amount} one-time</td>
              <td>${daytona.freeCredits.amount} one-time</td>
              <td className="compare-highlight-col">${free.monthlyCredits}/mo</td>
              <td className="compare-highlight-col">${max.monthlyCredits}/mo</td>
            </tr>
            <tr>
              <td className="compare-row-label">Max session</td>
              <td>{e2bHobby.maxSessionHours} hr (Hobby) / {e2bPro?.maxSessionHours} hrs (Pro)</td>
              <td>No limit</td>
              <td className="compare-highlight-col">{free.maxSessionHours} hour</td>
              <td className="compare-highlight-col">{max.maxSessionHours} hours</td>
            </tr>
            <tr>
              <td className="compare-row-label">Max concurrent</td>
              <td>{e2bHobby.maxConcurrent} (Hobby) / {e2bPro?.maxConcurrent} (Pro)</td>
              <td>No limit</td>
              <td className="compare-highlight-col">{free.maxConcurrent}</td>
              <td className="compare-highlight-col">{max.maxConcurrent}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

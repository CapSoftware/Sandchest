function Bone({ width, height = 13 }: { width?: number | string; height?: number }) {
  return (
    <div
      className="skel"
      style={{ width: width ?? '100%', height, flexShrink: width ? 0 : undefined }}
    />
  )
}

function TableSkeleton({
  columns,
  rows = 5,
}: {
  columns: Array<{ width?: number | string }>
  rows?: number
}) {
  return (
    <div className="dash-table-wrap">
      <table className="dash-table">
        <thead>
          <tr>
            {columns.map((col, i) => (
              <th key={i}>
                <Bone width={col.width ?? '60%'} height={11} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }, (_, i) => (
            <tr key={i}>
              {columns.map((col, j) => (
                <td key={j}>
                  <Bone width={col.width ?? '80%'} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function UsageOverviewSkeleton() {
  return (
    <section className="usage-overview">
      <div className="usage-overview-stats">
        <div className="usage-overview-stat">
          <Bone width={50} height={11} />
          <Bone width={48} height={18} />
        </div>
        <div className="usage-overview-stat">
          <Bone width={100} height={11} />
          <Bone width={48} height={18} />
        </div>
        <div className="usage-overview-stat">
          <Bone width={80} height={11} />
          <Bone width={64} height={18} />
        </div>
      </div>
      <div className="usage-overview-bars">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="usage-overview-bar-row">
            <div className="usage-overview-bar-label">
              <Bone width={80} height={12} />
              <Bone width={50} height={12} />
            </div>
            <div className="usage-overview-bar-track">
              <Bone width="35%" height={4} />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

export function SandboxTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <TableSkeleton
      rows={rows}
      columns={[
        { width: 140 },
        { width: 60 },
        { width: 80 },
        { width: 60 },
        { width: 80 },
        { width: 50 },
      ]}
    />
  )
}

export function SandboxListSkeleton() {
  return (
    <div>
      <UsageOverviewSkeleton />
      <div className="dash-page-header">
        <Bone width={120} height={18} />
      </div>
      <div className="dash-filters">
        {Array.from({ length: 5 }, (_, i) => (
          <Bone key={i} width={i === 0 ? 40 : 60} height={28} />
        ))}
      </div>
      <SandboxTableSkeleton />
    </div>
  )
}

export function ApiKeysSkeleton() {
  return (
    <div>
      <div className="dash-page-header">
        <Bone width={100} height={18} />
        <Bone width={100} height={34} />
      </div>
      <TableSkeleton
        rows={3}
        columns={[
          { width: 100 },
          { width: 120 },
          { width: 80 },
          { width: 60 },
        ]}
      />
    </div>
  )
}

export function BillingSkeleton() {
  return (
    <div>
      <div className="dash-page-header">
        <Bone width={70} height={18} />
        <Bone width={130} height={34} />
      </div>
      <section className="dash-section">
        <div className="dash-section-title">
          <Bone width={100} height={14} />
        </div>
        <div className="billing-plan-card">
          <div className="billing-plan-info">
            <Bone width={80} height={16} />
          </div>
        </div>
      </section>
      <section className="dash-section">
        <div className="dash-section-title">
          <Bone width={50} height={14} />
        </div>
        <div className="billing-usage-list">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="billing-usage-row">
              <div className="billing-usage-label">
                <Bone width={100} height={12} />
                <Bone width={60} height={12} />
              </div>
              <div className="billing-usage-bar">
                <Bone width="40%" height={4} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

export function SettingsSkeleton() {
  return (
    <div>
      <div className="dash-page-header">
        <Bone width={90} height={18} />
      </div>
      <section className="dash-section">
        <div className="dash-section-title">
          <Bone width={100} height={14} />
        </div>
        <div className="dash-inline-form">
          <div className="dash-field">
            <Bone width={40} height={12} />
            <div style={{ marginTop: 6 }}>
              <Bone width="100%" height={36} />
            </div>
          </div>
          <div className="dash-field">
            <Bone width={30} height={12} />
            <div style={{ marginTop: 6 }}>
              <Bone width={120} />
            </div>
          </div>
          <div className="dash-field">
            <Bone width={16} height={12} />
            <div style={{ marginTop: 6 }}>
              <Bone width={200} />
            </div>
          </div>
        </div>
      </section>
      <section className="dash-section">
        <div className="dash-section-title">
          <Bone width={70} height={14} />
        </div>
        <TableSkeleton
          rows={2}
          columns={[
            { width: 160 },
            { width: 100 },
            { width: 60 },
            { width: 60 },
          ]}
        />
      </section>
    </div>
  )
}

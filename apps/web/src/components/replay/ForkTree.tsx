'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { ReplayForkTreeNode } from '@sandchest/contract'
import { formatRelativeTime } from '@/lib/format'

interface ForkTreeProps {
  tree: ReplayForkTreeNode
  currentId: string
}

function TreeNode({
  node,
  currentId,
  depth,
  isLast,
}: {
  node: ReplayForkTreeNode
  currentId: string
  depth: number
  isLast: boolean
}) {
  const [collapsed, setCollapsed] = useState(false)
  const isCurrent = node.sandbox_id === currentId
  const hasChildren = node.children.length > 0

  return (
    <div className="ft-node-wrapper">
      <div className={`ft-node ${isCurrent ? 'ft-current' : ''}`}>
        {depth > 0 && (
          <span className="ft-branch">{isLast ? '\u2514\u2500 ' : '\u251c\u2500 '}</span>
        )}

        <span className="ft-dot" />

        {isCurrent ? (
          <span className="ft-id ft-id-current">{node.sandbox_id}</span>
        ) : (
          <Link href={`/s/${node.sandbox_id}`} className="ft-id ft-id-link">
            {node.sandbox_id}
          </Link>
        )}

        {isCurrent && <span className="ft-badge">current</span>}

        {node.forked_at && (
          <span className="ft-time">
            forked {formatRelativeTime(node.forked_at)}
          </span>
        )}

        {hasChildren && (
          <button
            type="button"
            className="ft-collapse-btn"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? `+${node.children.length}` : '\u2212'}
          </button>
        )}
      </div>

      {hasChildren && !collapsed && (
        <div className="ft-children" style={{ marginLeft: depth > 0 ? 20 : 12 }}>
          {node.children.map((child, i) => (
            <TreeNode
              key={child.sandbox_id}
              node={child}
              currentId={currentId}
              depth={depth + 1}
              isLast={i === node.children.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function ForkTree({ tree, currentId }: ForkTreeProps) {
  if (tree.children.length === 0 && tree.sandbox_id === currentId) {
    return null
  }

  return (
    <div className="ft-container">
      <h3 className="replay-section-title">Fork Tree</h3>
      <TreeNode node={tree} currentId={currentId} depth={0} isLast={true} />
    </div>
  )
}

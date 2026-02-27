import { relations } from 'drizzle-orm'
import { nodes } from './nodes.js'
import { images } from './images.js'
import { profiles } from './profiles.js'
import { sandboxes } from './sandboxes.js'
import { sandboxSessions } from './sandbox-sessions.js'
import { execs } from './execs.js'
import { artifacts } from './artifacts.js'

export const nodesRelations = relations(nodes, ({ many }) => ({
  sandboxes: many(sandboxes),
}))

export const imagesRelations = relations(images, ({ many }) => ({
  sandboxes: many(sandboxes),
}))

export const profilesRelations = relations(profiles, ({ many }) => ({
  sandboxes: many(sandboxes),
}))

export const sandboxesRelations = relations(sandboxes, ({ one, many }) => ({
  node: one(nodes, { fields: [sandboxes.nodeId], references: [nodes.id] }),
  image: one(images, { fields: [sandboxes.imageId], references: [images.id] }),
  profile: one(profiles, { fields: [sandboxes.profileId], references: [profiles.id] }),
  parent: one(sandboxes, {
    fields: [sandboxes.forkedFrom],
    references: [sandboxes.id],
    relationName: 'forkTree',
  }),
  forks: many(sandboxes, { relationName: 'forkTree' }),
  sessions: many(sandboxSessions),
  execs: many(execs),
  artifacts: many(artifacts),
}))

export const sandboxSessionsRelations = relations(sandboxSessions, ({ one }) => ({
  sandbox: one(sandboxes, {
    fields: [sandboxSessions.sandboxId],
    references: [sandboxes.id],
  }),
}))

export const execsRelations = relations(execs, ({ one }) => ({
  sandbox: one(sandboxes, { fields: [execs.sandboxId], references: [sandboxes.id] }),
  session: one(sandboxSessions, { fields: [execs.sessionId], references: [sandboxSessions.id] }),
}))

export const artifactsRelations = relations(artifacts, ({ one }) => ({
  sandbox: one(sandboxes, { fields: [artifacts.sandboxId], references: [sandboxes.id] }),
  exec: one(execs, { fields: [artifacts.execId], references: [execs.id] }),
}))

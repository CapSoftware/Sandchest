import { binary, timestamp } from 'drizzle-orm/mysql-core'

/** UUIDv7 stored as BINARY(16) */
export const uuidv7Binary = (name: string) => binary(name, { length: 16 }).$type<Uint8Array>()

/** TIMESTAMP(6) — microsecond precision */
export const timestampMicro = (name: string) => timestamp(name, { fsp: 6, mode: 'date' })

/** created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) */
export const createdAt = () => timestampMicro('created_at').notNull().defaultNow()

/** updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6) */
export const updatedAt = () => timestampMicro('updated_at').notNull().defaultNow().onUpdateNow()

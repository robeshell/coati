import type { Db } from '@/db/client'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { gw_devices, gw_keys } from '@/db/schema/gateway'
import { loadAdminsWithRolesByIds } from '@/common/auth'
import { deviceStartPolicy, type DeviceStartPolicy } from './device-policy'

/** Device admission and one-time redemption own their complete database transactions. */
export class DeviceRepository {
  constructor(readonly db: Db) {}
  // Shared fixed-window admission for unauthenticated device start/poll.
  // The global lock also bounds the number of identities under address churn.
  async admitDeviceRequest(identity: string) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(73462110)`)
      await tx.execute(sql`delete from gw_device_rate_limits
        where started_at <= clock_timestamp() - interval '60 seconds'`)
      const current = await tx.execute(sql`select count,
        greatest(1, ceil(extract(epoch from started_at + interval '60 seconds' - clock_timestamp())))::integer as retry_after
        from gw_device_rate_limits where identity = ${identity}`)
      if (current.rows[0]) {
        const row = current.rows[0]
        if (Number(row.count) >= 60) return Number(row.retry_after)
        await tx.execute(
          sql`update gw_device_rate_limits set count = count + 1 where identity = ${identity}`,
        )
      } else {
        const size = await tx.execute(
          sql`select count(*)::integer as count from gw_device_rate_limits`,
        )
        if (Number(size.rows[0]?.count) >= 10000) return 60
        await tx.execute(
          sql`insert into gw_device_rate_limits (identity, started_at) values (${identity}, clock_timestamp())`,
        )
      }
      return 0
    })
  }
  async createDevice(
    values: typeof gw_devices.$inferInsert,
    policy: DeviceStartPolicy = deviceStartPolicy(),
  ) {
    return this.db.transaction(async (tx) => {
      // Database-wide admission, matching the Python gateway's lock namespace.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(73462109)`)
      await tx
        .delete(gw_devices)
        .where(
          sql`${gw_devices.created_at} < clock_timestamp() - (${policy.retentionHours} * interval '1 hour')`,
        )
      await tx
        .update(gw_devices)
        .set({ status: 'expired' })
        .where(
          and(
            inArray(gw_devices.status, ['pending', 'approved']),
            sql`${gw_devices.expires_at} <= clock_timestamp()`,
          ),
        )
      const counts = await tx.execute<{ recent: number; active: number }>(sql`
        SELECT count(*) FILTER (WHERE created_at >= clock_timestamp() - interval '1 minute')::int AS recent,
          count(*) FILTER (WHERE status IN ('pending','approved') AND expires_at > clock_timestamp())::int AS active
        FROM gw_devices`)
      if (counts.rows[0]!.recent >= policy.startsPerMinute)
        return 'rate_limited' as const
      if (counts.rows[0]!.active >= policy.maxActive)
        return 'capacity_exceeded' as const
      await tx.insert(gw_devices).values({
        ...values,
        created_at: sql`clock_timestamp()`,
        expires_at: sql`clock_timestamp() + interval '600 seconds'`,
      })
      return 'created' as const
    })
  }
  async confirmDevice(
    code: string,
    owner: number,
    decision: 'approved' | 'denied' = 'approved',
  ) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(gw_devices)
        .where(eq(gw_devices.user_code, code))
        .for('update')
      if (!row) return { error: 'invalid_user_code' as const, status: 'missing' }
      const clock = await tx.execute<{ expired: boolean }>(
        sql`SELECT ${row.expires_at}::timestamptz <= clock_timestamp() AS expired`,
      )
      if (
        ['pending', 'approved'].includes(row.status) &&
        clock.rows[0]!.expired
      ) {
        await tx
          .update(gw_devices)
          .set({ status: 'expired' })
          .where(eq(gw_devices.id, row.id))
        return { error: 'expired_token' as const, status: 'expired' }
      }
      if (row.status !== 'pending')
        return {
          status: row.status,
          error:
            row.status === 'expired'
              ? ('expired_token' as const)
              : ('already_decided' as const),
        }
      await tx
        .update(gw_devices)
        .set({ owner_id: owner, status: decision })
        .where(eq(gw_devices.id, row.id))
      return { user_code: row.user_code }
    })
  }
  async consumeDevice(
    hash: string,
    key: Omit<typeof gw_keys.$inferInsert, 'owner_id'>,
  ) {
    return this.db.transaction(async (tx) => {
      const [device] = await tx
        .select()
        .from(gw_devices)
        .where(eq(gw_devices.device_hash, hash))
        .for('update')
      if (!device) return 'invalid_device_code'
      const clock = await tx.execute<{ expired: boolean }>(
        sql`SELECT ${device.expires_at}::timestamptz <= clock_timestamp() AS expired`,
      )
      if (
        ['pending', 'approved'].includes(device.status) &&
        clock.rows[0]!.expired
      ) {
        await tx
          .update(gw_devices)
          .set({ status: 'expired' })
          .where(eq(gw_devices.id, device.id))
        return 'expired_token'
      }
      if (device.status === 'expired') return 'expired_token'
      if (device.status === 'consumed') return 'already_consumed'
      if (device.status === 'pending') return 'authorization_pending'
      if (device.status !== 'approved' || !device.owner_id)
        return 'access_denied'
      const [user] = await loadAdminsWithRolesByIds(tx, [device.owner_id])
      if (!user) return 'access_denied'
      await tx.insert(gw_keys).values({ ...key, owner_id: device.owner_id })
      await tx
        .update(gw_devices)
        .set({ status: 'consumed' })
        .where(eq(gw_devices.id, device.id))
      return { user }
    })
  }
}

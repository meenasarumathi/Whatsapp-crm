import { createServiceDb, type DbClient } from '@/lib/db'

// Shared service-role database client (row level security bypassed) for
// background engine work that has no signed-in user.
let _serviceDb: DbClient | null = null

export function serviceDb(): DbClient {
  if (!_serviceDb) _serviceDb = createServiceDb()
  return _serviceDb
}

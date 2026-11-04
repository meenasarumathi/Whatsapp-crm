// In-memory stand-in for the service DbClient, enough of the query
// builder for the automation engine (select/insert/update/delete/upsert,
// eq/neq/is/in/gte/lte, order/limit, single/maybeSingle, head counts).
// Lets tests run real automations end to end without a database.

type Row = Record<string, unknown>
type Filter = (r: Row) => boolean

export interface MemoryDb {
  tables: Record<string, Row[]>
  rpcCalls: { fn: string; args: unknown }[]
  from: (table: string) => unknown
  rpc: (fn: string, args?: unknown) => Promise<{ data: null; error: null }>
}

let seq = 0
const newId = () => `id-${++seq}`

export function createMemoryDb(seed: Record<string, Row[]> = {}): MemoryDb {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  const rpcCalls: { fn: string; args: unknown }[] = []
  const rows = (t: string) => (tables[t] ??= [])

  function query(table: string) {
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: Row | Row[] | undefined
    let upsertKeys: string[] = ['id']
    let head = false
    let wantCount = false
    let returning = false
    let one: 'single' | 'maybe' | null = null
    let limitN: number | null = null
    const filters: Filter[] = []
    const orders: { col: string; asc: boolean }[] = []

    function run() {
      const all = rows(table)
      let affected: Row[] = []
      if (op === 'insert' || op === 'upsert') {
        const list: Row[] = (Array.isArray(payload) ? payload : [payload!]).map((r) => ({ id: newId(), created_at: new Date().toISOString(), ...r }))
        for (const r of list) {
          if (op === 'upsert') {
            const hit = all.find((x) => upsertKeys.every((k) => x[k] === r[k]))
            if (hit) continue
          }
          all.push(r)
          affected.push(r)
        }
      } else {
        let matched = all.filter((r) => filters.every((f) => f(r)))
        if (op === 'update') {
          matched.forEach((r) => Object.assign(r, payload))
          affected = matched
        } else if (op === 'delete') {
          tables[table] = all.filter((r) => !matched.includes(r))
          affected = matched
        } else {
          for (const o of [...orders].reverse()) {
            matched = [...matched].sort((a, b) => {
              const av = a[o.col] as number | string
              const bv = b[o.col] as number | string
              return (av < bv ? -1 : av > bv ? 1 : 0) * (o.asc ? 1 : -1)
            })
          }
          if (limitN !== null) matched = matched.slice(0, limitN)
          affected = matched
        }
      }
      const count = wantCount ? affected.length : null
      if (op !== 'select' && !returning) return { data: null, error: null, count }
      if (head) return { data: null, error: null, count }
      if (one) {
        if (affected.length === 0) {
          return one === 'single'
            ? { data: null, error: { message: 'no rows', code: 'PGRST116' }, count }
            : { data: null, error: null, count }
        }
        return { data: { ...affected[0] }, error: null, count }
      }
      return { data: affected.map((r) => ({ ...r })), error: null, count }
    }

    const b: Record<string, unknown> = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (op !== 'select') returning = true
        wantCount = Boolean(opts?.count)
        head = Boolean(opts?.head)
        return b
      },
      insert: (p: Row | Row[]) => ((op = 'insert'), (payload = p), b),
      upsert: (p: Row | Row[], o?: { onConflict?: string }) => {
        op = 'upsert'
        payload = p
        if (o?.onConflict) upsertKeys = o.onConflict.split(',').map((s) => s.trim())
        return b
      },
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      delete: () => ((op = 'delete'), b),
      eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
      neq: (c: string, v: unknown) => (filters.push((r) => r[c] !== v), b),
      is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      gte: (c: string, v: string | number) => (filters.push((r) => (r[c] as string | number) >= v), b),
      lte: (c: string, v: string | number) => (filters.push((r) => (r[c] as string | number) <= v), b),
      order: (c: string, o?: { ascending?: boolean }) => (orders.push({ col: c, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limitN = n), b),
      single: () => ((one = 'single'), Promise.resolve(run())),
      maybeSingle: () => ((one = 'maybe'), Promise.resolve(run())),
      then: (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, err),
    }
    return b
  }

  return {
    tables,
    rpcCalls,
    from: query,
    rpc: (fn: string, args?: unknown) => {
      rpcCalls.push({ fn, args })
      return Promise.resolve({ data: null, error: null })
    },
  }
}

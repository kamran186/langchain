import { tool, type ToolRuntime } from '@langchain/core/tools';
import { z } from 'zod';
import type pg from 'pg';
import type { Scope } from '../memory/memory.repository.js';

export const customerFilters = z.object({
  name: z.string().min(1).optional(), email: z.string().min(1).optional(),
  city: z.string().min(1).optional(), status: z.enum(['active','inactive']).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();
export type CustomerFilters = z.infer<typeof customerFilters>;

export async function queryCustomers(pool: pg.Pool, organizationId: string, raw: unknown) {
  const filters = customerFilters.parse(raw);
  const values: unknown[] = [organizationId];
  const conditions = ['organization_id=$1'];
  for (const key of ['name','email','city'] as const) {
    if (filters[key]) {
      values.push(`%${filters[key]!.replace(/[\\%_]/g, '\\$&')}%`);
      conditions.push(`${key} ILIKE $${values.length} ESCAPE '\\'`);
    }
  }
  if (filters.status) { values.push(filters.status); conditions.push(`status=$${values.length}`); }
  const where = conditions.join(' AND ');
  const count = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM customers WHERE ${where}`, values);
  values.push(filters.limit ?? 10);
  const rows = await pool.query<{ id: string; name: string; email: string | null; city: string | null; status: string }>(
    `SELECT id,name,email,city,status FROM customers WHERE ${where} ORDER BY lower(name),id LIMIT $${values.length}`, values);
  return { records: rows.rows, totalMatched: Number(count.rows[0]?.count ?? 0), appliedFilters: { ...filters, limit: filters.limit ?? 10 } };
}

export function createGetCustomersTool(pool: pg.Pool, organizationId?: string) {
  return tool(async (filters, runtime: ToolRuntime<{ context: Scope }>) => {
    const scopedOrganizationId = organizationId ?? runtime.state?.context?.organizationId;
    if (!scopedOrganizationId) throw new Error('Customer tool missing organization scope');
    try {
      return JSON.stringify(await queryCustomers(pool, scopedOrganizationId, filters));
    } catch {
      return JSON.stringify({ error: 'Customer lookup failed' });
    }
  }, {
    name: 'get_customers',
    description: 'Search current customer records in the request organization when the user asks to find, list, or filter customers. Filter by name, email, city, active or inactive status, and result limit. Read-only; organization scope is supplied by the application.',
    schema: customerFilters,
  });
}

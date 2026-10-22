import type { Pool } from "pg";
import type { RequestContext } from "../context.js";

export type CustomerFields = {
  name: string;
  city: string;
  country: string;
  age: number;
  email: string;
  gender: string;
  network: string;
};
export type Customer = CustomerFields & { id: string; organizationId: string; createdBy: string };
export type CustomerFilters = Partial<Customer> & {
  ageMin?: number;
  ageMax?: number;
  limit: number;
  offset: number;
};

const columns = 'id, name, city, country, age, email, gender, network, organization_id AS "organizationId", created_by AS "createdBy"';

export class CustomerRepository {
  constructor(private readonly pool: Pool) {}

  async ensureSchema(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id text NOT NULL,
        employee_id text NOT NULL,
        created_by text NOT NULL,
        name text NOT NULL,
        city text NOT NULL,
        country text NOT NULL,
        age integer NOT NULL CHECK (age BETWEEN 0 AND 120),
        email text NOT NULL,
        gender text NOT NULL,
        network text NOT NULL,
        idempotency_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
      `);
      await client.query(`
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
            AND table_name = 'customers' AND column_name = 'user_id')
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
            AND table_name = 'customers' AND column_name = 'created_by') THEN
            ALTER TABLE customers RENAME COLUMN user_id TO created_by;
          ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
            AND table_name = 'customers' AND column_name = 'owner_user_id')
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
            AND table_name = 'customers' AND column_name = 'created_by') THEN
            ALTER TABLE customers RENAME COLUMN owner_user_id TO created_by;
          END IF;
        END $$;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS organization_id text;
        ALTER TABLE customers ADD COLUMN IF NOT EXISTS employee_id text;
      `);
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS customers_org_email_unique ON customers (organization_id, lower(email))");
      await client.query("CREATE UNIQUE INDEX IF NOT EXISTS customers_org_idempotency_unique ON customers (organization_id, idempotency_key)");
      await client.query("CREATE INDEX IF NOT EXISTS customers_org_created_by_idx ON customers (organization_id, created_by)");
      await client.query("DROP INDEX IF EXISTS customers_owner_email_unique");
      await client.query("DROP INDEX IF EXISTS customers_owner_idempotency_unique");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async create(context: RequestContext, fields: CustomerFields, idempotencyKey: string): Promise<Customer> {
    if (!idempotencyKey) throw new Error("Customer create requires an approved write");
    const values = [context.organizationId, context.employeeId, context.userId, fields.name, fields.city, fields.country, fields.age,
      fields.email, fields.gender, fields.network, idempotencyKey];
    const result = await this.pool.query<Customer>(`
      INSERT INTO customers (organization_id, employee_id, created_by, name, city, country, age, email, gender, network, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (organization_id, idempotency_key)
      DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
      RETURNING ${columns}
    `, values);
    if (!result.rows[0]) throw new Error("Customer create returned no row");
    return result.rows[0];
  }

  async get(context: RequestContext, filters: CustomerFilters): Promise<{ customers: Customer[]; limit: number; offset: number }> {
    const values: unknown[] = [context.organizationId];
    const clauses = ["organization_id = $1"];
    if (filters.id !== undefined) { values.push(filters.id); clauses.push(`id = $${values.length}`); }
    if (filters.organizationId !== undefined) { values.push(filters.organizationId); clauses.push(`organization_id = $${values.length}`); }
    if (filters.createdBy !== undefined) { values.push(filters.createdBy); clauses.push(`created_by = $${values.length}`); }
    for (const field of ["name", "city", "country", "email", "gender", "network"] as const) {
      const value = filters[field];
      if (value !== undefined) {
        values.push(value);
        clauses.push(`LOWER(${field}) = LOWER($${values.length})`);
      }
    }
    if (filters.age !== undefined) { values.push(filters.age); clauses.push(`age = $${values.length}`); }
    if (filters.ageMin !== undefined) { values.push(filters.ageMin); clauses.push(`age >= $${values.length}`); }
    if (filters.ageMax !== undefined) { values.push(filters.ageMax); clauses.push(`age <= $${values.length}`); }
    values.push(filters.limit, filters.offset);
    const result = await this.pool.query<Customer>(`
      SELECT ${columns} FROM customers
      WHERE ${clauses.join(" AND ")}
      ORDER BY name ASC, id ASC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    return { customers: result.rows, limit: filters.limit, offset: filters.offset };
  }
}

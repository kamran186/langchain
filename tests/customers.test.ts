import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CustomerRepository } from "../src/db/customers.js";
import { registerCustomerTools } from "../src/tools/customers.js";
import { ToolRegistry } from "../src/tools/index.js";

const context = { organizationId: "org-1", employeeId: "employee-1", userId: "", sessionId: "session-1", threadId: "thread-1" };
const customer = {
  id: "3d6f365e-91ac-4338-a29d-eed376897d85",
  name: "Amina Khan", city: "Lahore", country: "Pakistan", age: 31,
  email: "amina@example.com", gender: "female", network: "Jazz",
  organizationId: "org-1", createdBy: "",
};

function database() {
  const queries: { sql: string; values: unknown[] }[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      queries.push({ sql, values });
      return { rows: [customer] };
    },
  } as unknown as Pool;
  return { queries, repository: new CustomerRepository(pool) };
}

describe("customer tools", () => {
  it("exposes both customer schemas to dynamic model selection", () => {
    const { repository } = database();
    const registry = new ToolRegistry();
    registerCustomerTools(registry, repository);
    const descriptions = registry.list(context).map((tool) => ({ name: tool.name, schema: z.toJSONSchema(tool.schema) }));
    expect(descriptions.map((tool) => tool.name)).toEqual(["create_customer", "get_customers"]);
    expect(descriptions.every((tool) => tool.schema.type === "object")).toBe(true);
  });

  it("previews a complete customer create and writes only after the frozen approval", async () => {
    const { queries, repository } = database();
    const registry = new ToolRegistry();
    registerCustomerTools(registry, repository);
    const proposal = registry.prepareWrites([{ id: "create-1", name: "create_customer", args: {
      name: "Amina Khan", city: "Lahore", country: "Pakistan", age: 31,
      email: "AMINA@example.com", gender: "female", network: "Jazz",
      organizationId: "untrusted-org", createdBy: "untrusted-user",
    } }], context);

    expect(proposal.previews[0]).toEqual({
      target: "customers", effect: "Create customer",
      fields: {
        name: "Amina Khan", city: "Lahore", country: "Pakistan", age: 31,
        email: "amina@example.com", gender: "female", network: "Jazz",
        organizationId: "org-1", createdBy: "",
      },
    });
    expect(queries).toEqual([]);
    await expect(registry.executeApprovedWrites(proposal, "wrong", context)).rejects.toThrow(/approval/i);
    expect(queries).toEqual([]);

    const result = await registry.executeApprovedWrites(proposal, proposal.id, { ...context, userId: "approval-actor" });
    expect(result[0].result).toEqual(customer);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/INSERT INTO customers/);
    expect(queries[0].sql).toMatch(/organization_id, employee_id, created_by/);
    expect(queries[0].sql).toContain('organization_id AS "organizationId"');
    expect(queries[0].sql).toContain('created_by AS "createdBy"');
    expect(queries[0].sql).toMatch(/ON CONFLICT \(organization_id, idempotency_key\)/);
    expect(queries[0].values).toEqual([
      "org-1", "employee-1", "", "Amina Khan", "Lahore", "Pakistan", 31,
      "amina@example.com", "female", "Jazz", `${proposal.id}:create-1`,
    ]);
  });

  it("applies customer filters and pagination within the current organization's records", async () => {
    const { queries, repository } = database();
    const registry = new ToolRegistry();
    registerCustomerTools(registry, repository);
    const result = await registry.executeReads([{ id: "read-1", name: "get_customers", args: {
      city: "lahore", country: "PAKISTAN", ageMin: 30, ageMax: 35,
      network: "Jazz", limit: 10, offset: 20,
    } }], context);

    expect(result[0].result).toEqual({ customers: [customer], limit: 10, offset: 20 });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/organization_id = \$1/);
    expect(queries[0].sql).toMatch(/LOWER\(city\) = LOWER\(\$2\)/);
    expect(queries[0].sql).toMatch(/LOWER\(country\) = LOWER\(\$3\)/);
    expect(queries[0].sql).toMatch(/LOWER\(network\) = LOWER\(\$4\)/);
    expect(queries[0].sql).toMatch(/age >= \$5/);
    expect(queries[0].sql).toMatch(/age <= \$6/);
    expect(queries[0].sql).toMatch(/LIMIT \$7 OFFSET \$8/);
    expect(queries[0].values).toEqual(["org-1", "lahore", "PAKISTAN", "Jazz", 30, 35, 10, 20]);
  });

  it("rejects invalid customer details and reversed age filters before querying", async () => {
    const { queries, repository } = database();
    const registry = new ToolRegistry();
    registerCustomerTools(registry, repository);
    expect(() => registry.prepareWrites([{ id: "bad", name: "create_customer", args: {
      name: "Amina", city: "Lahore", country: "Pakistan", age: -1,
      email: "not-an-email", gender: "female", network: "Jazz",
    } }], context)).toThrow();
    await expect(registry.executeReads([{ id: "bad", name: "get_customers", args: {
      ageMin: 40, ageMax: 20,
    } }], context)).rejects.toThrow();
    expect(queries).toEqual([]);
  });

  it("filters OrganizationId and CreatedBy without replacing the request organization scope", async () => {
    const { queries, repository } = database();
    const registry = new ToolRegistry();
    registerCustomerTools(registry, repository);
    await registry.executeReads([{ id: "read-by-creator", name: "get_customers", args: {
      organizationId: "other-org", createdBy: "  creator value  ", limit: 5,
    } }], context);
    expect(queries[0].sql).toMatch(/organization_id = \$1 AND organization_id = \$2 AND created_by = \$3/);
    expect(queries[0].values).toEqual(["org-1", "other-org", "  creator value  ", 5, 0]);
    expect(queries[0].sql).toContain('created_by AS "createdBy"');
  });

  it("returns a clear tool result when a customer email already exists", async () => {
    const pool = { query: async () => { throw Object.assign(new Error("duplicate key"), {
      code: "23505", constraint: "customers_org_email_unique",
    }); } } as unknown as Pool;
    const registry = new ToolRegistry();
    registerCustomerTools(registry, new CustomerRepository(pool));
    const proposal = registry.prepareWrites([{ id: "create-2", name: "create_customer", args: {
      name: "Amina Khan", city: "Lahore", country: "Pakistan", age: 31,
      email: "amina@example.com", gender: "female", network: "Jazz",
    } }], context);
    const result = await registry.executeApprovedWrites(proposal, proposal.id, context);
    expect(result[0].result).toEqual({ code: "duplicate_customer_email", error: "A customer with this email already exists" });
  });
});

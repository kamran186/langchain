import { z } from "zod";
import type { CustomerRepository } from "../db/customers.js";
import type { ToolRegistry } from "./index.js";

const value = z.string().trim().min(1).max(200);
const customerInput = z.object({
  name: value,
  city: value,
  country: value,
  age: z.number().int().min(0).max(120),
  email: z.email().trim().toLowerCase(),
  gender: value,
  network: value,
});
const ageFilter = z.number().int().min(0).max(120).optional();
const customerFilters = z.object({
  id: z.uuid().optional(),
  organizationId: z.string().optional(), createdBy: z.string().optional(),
  name: value.optional(), city: value.optional(), country: value.optional(),
  age: ageFilter, ageMin: ageFilter, ageMax: ageFilter,
  email: z.email().trim().toLowerCase().optional(),
  gender: value.optional(), network: value.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  offset: z.number().int().min(0).default(0),
}).refine((filters) => filters.ageMin === undefined || filters.ageMax === undefined || filters.ageMin <= filters.ageMax, {
  message: "ageMin must not exceed ageMax", path: ["ageMin"],
});

export function registerCustomerTools(registry: ToolRegistry, repository: CustomerRepository): void {
  registry.register({
    name: "create_customer",
    description: "Create a customer in local PostgreSQL. ID is generated on approval. Requires name, city, country, age, email, gender, and network. OrganizationId and CreatedBy are taken from the request context; CreatedBy is the request UserId.",
    effect: "write",
    schema: customerInput,
    preview: (fields, context) => ({
      target: "customers", fields: { ...fields, organizationId: context.organizationId, createdBy: context.userId }, effect: "Create customer",
    }),
    run: async (fields, context) => {
      try {
        return await repository.create(context, fields, context.idempotencyKey ?? "");
      } catch (error) {
        if (isDuplicateEmail(error)) {
          return { code: "duplicate_customer_email", error: "A customer with this email already exists" };
        }
        throw error;
      }
    },
  });
  registry.register({
    name: "get_customers",
    description: "Get customers from local PostgreSQL, including OrganizationId and CreatedBy (UserId). Supports ID, exact case-insensitive customer text filters, age or age range, exact organizationId and createdBy filters, limit, and offset. Results always stay within the request organization.",
    effect: "read",
    schema: customerFilters,
    run: (filters, context) => repository.get(context, filters),
  });
}

function isDuplicateEmail(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505" &&
    "constraint" in error && error.constraint === "customers_org_email_unique";
}

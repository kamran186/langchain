import { readFileSync } from "node:fs";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const CustomerSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  email: z.string().trim().min(1),
  bfdkn_city: z.string().trim().min(1).optional(),
  sdfnks_city: z.string().trim().min(1).optional(),
  mfbzdfkj_city: z.string().trim().min(1).optional(),
  status: z.enum(["active", "inactive"]),
}).passthrough();

const customers = z.array(CustomerSchema).parse(
  JSON.parse(
    readFileSync(
      new URL("../../data/customers.json", import.meta.url),
      "utf8",
    ),
  ),
);

const CustomerSearchSchema = z.object({
  customerId: z.string().trim().min(1).optional(),
  customerIds: z.array(z.string().trim().min(1)).min(1).optional(),
  name: z.string().trim().min(1).optional(),
  email: z.string().trim().min(1).optional(),
  bfdkn_city: z.string().trim().min(1).optional(),
  sdfnks_city: z.string().trim().min(1).optional(),
  mfbzdfkj_city: z.string().trim().min(1).optional(),
  status: z.string().trim().min(1).optional(),
  limit: z.number().int().positive().optional(),
}).strict();

export type CustomerSearch = z.infer<typeof CustomerSearchSchema>;

const normalize = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase();

export function findCustomers(filters: CustomerSearch = {}) {
  return customers.filter((customer) =>
    (
      filters.customerId === undefined ||
      normalize(customer.id) === normalize(filters.customerId)
    ) &&
    (
      filters.customerIds === undefined ||
      filters.customerIds.some(
        (id) => normalize(customer.id) === normalize(id),
      )
    ) &&
    (
      filters.name === undefined ||
      normalize(customer.name).includes(normalize(filters.name))
    ) &&
    (
      filters.email === undefined ||
      normalize(customer.email) === normalize(filters.email)
    ) &&
    (
      filters.status === undefined ||
      normalize(customer.status) === normalize(filters.status)
    )
  );
}

export function resolveCustomer(reference: string) {
  const byId = findCustomers({ customerId: reference });

  return byId.length > 0
    ? byId
    : findCustomers({ name: reference });
}

export const getCustomer = tool(
  (filters) => {
    const matches = findCustomers(filters);
    const selected = matches.slice(0, filters.limit ?? matches.length);

    return {
      found: matches.length > 0,
      dataSource: "sample",
      total: matches.length,
      returned: selected.length,
      customers: selected,
    };
  },
  {
    name: "get_customer",
    description: [
      "Retrieve fictional sample customers.",
      "Every filter is optional; {} returns all customers.",
      "customerId retrieves one ID; customerIds retrieves multiple IDs.",
      "Name uses substring matching. Other text filters use exact matching.",
      "Text comparisons ignore case and surrounding whitespace.",
      "Supplied filters combine with AND.",
      "Use limit for the requested number of customers.",
      "Conversational facts such as a Jira association are separate from",
      "these source records. Use IDs resolved from session memory.",
    ].join(" "),
    schema: CustomerSearchSchema,
  },
);
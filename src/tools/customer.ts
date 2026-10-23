import { tool } from "@langchain/core/tools";
import { z } from "zod";

type Customer = {
  id: string;
  name: string;
  email: string;
  status: "active" | "inactive";
};

// Fictional records for learning.
// Replace this lookup with your database or API.
const sampleCustomers = new Map<string, Customer>([
  [
    "CUST-001",
    {
      id: "CUST-001",
      name: "Avery Morgan",
      email: "avery@example.com",
      status: "active",
    },
  ],
  [
    "CUST-002",
    {
      id: "CUST-002",
      name: "Jordan Taylor",
      email: "jordan@example.com",
      status: "inactive",
    },
  ],
]);

export const getCustomer = tool(
  ({ customerId }) => {
    const id = customerId.toUpperCase();
    const customer = sampleCustomers.get(id);

    if (!customer) {
      return {
        found: false,
        dataSource: "sample",
        customerId: id,
        message: "No sample customer was found with this ID.",
      };
    }

    return {
      found: true,
      dataSource: "sample",
      customer,
    };
  },
  {
    name: "get_customer",
    description:
      "Look up a customer by ID in fictional sample data. Returns name, email, and status, or a not-found result.",
    schema: z.object({
      customerId: z
        .string()
        .trim()
        .min(1)
        .describe("Customer ID, e.g. CUST-001"),
    }),
  },
);
import { z } from "zod";

export var servicenowQueryTableSchema = z.object({
  table: z.string().regex(/^[a-z][a-z0-9_]*$/, "Table name must match /^[a-z][a-z0-9_]*$/"),
  sysparm_query: z.string(),
  fields: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(1000).optional()
}).strict();

export type ServicenowQueryTableInput = z.infer<typeof servicenowQueryTableSchema>;

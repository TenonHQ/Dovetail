import { z } from "zod";

export var servicenowQueryTableSchema = z.object({
  table: z.string().regex(/^[a-z][a-z0-9_]*$/, "Table name must match /^[a-z][a-z0-9_]*$/"),
  sysparm_query: z.string(),
  fields: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  // Optional per-call instance retarget. Names an env file in the server's
  // working directory: a bare token like "prod" or "workshop" resolves to
  // ".env.<token>", or pass the full ".env.<name>" basename. Path separators
  // and traversal are rejected (no arbitrary filesystem reads) — see
  // resolveEnvFilePath in tools/servicenow.ts. Omit to use the instance the
  // server was started with.
  env: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^(\.env(\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+)$/,
      "env must be an env-file name like 'prod' or '.env.prod' — no path separators or '..'"
    )
    .optional()
}).strict();

export type ServicenowQueryTableInput = z.infer<typeof servicenowQueryTableSchema>;

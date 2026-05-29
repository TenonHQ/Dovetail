import { SchemaOptions, SchemaIndex } from "./types";
import { fetchSchema } from "./fetcher";
import { organizeSchema } from "./organizer";

export { fetchSchema } from "./fetcher";
export { organizeSchema, groupByApplication } from "./organizer";
export {
  readSchemaTree,
  writeSnapshot,
  listSnapshots,
  resolveSnapshotDir,
  normalizeField,
  SNAPSHOTS_DIRNAME,
} from "./snapshot";
export { diffSchemas, formatDiff } from "./diff";
export * from "./types";

export async function pullSchema(options: SchemaOptions): Promise<SchemaIndex> {
  const schema = await fetchSchema(options);

  const instanceName = options.instance.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const index = await organizeSchema({
    schema,
    outputDir: options.outputDir,
    instance: instanceName,
    scopes: options.scopes,
  });

  return index;
}

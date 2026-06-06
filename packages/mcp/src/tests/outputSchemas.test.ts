import { z } from "zod";
import { clickupGetTeamSyncOutput, servicenowQueryTableOutput } from "../outputSchemas";
import { buildDescriptorsForTests, RegistryDeps } from "../registry";

// Mirror the MCP SDK's validateToolOutput: z.object(shape) (strip mode) safeParse,
// throwing on failure. Representative returns are mirrored from the documented
// interfaces (TeamSyncJson / the servicenow_query_table return), not from the
// schema, so this asserts schema ⊇ the real shape.
function assertValidates(schema: any, value: any): void {
  var result = z.object(schema.shape).safeParse(value);
  if (!result.success) {
    throw new Error("output schema rejected the return shape: " + JSON.stringify(result.error.issues));
  }
  expect(result.success).toBe(true);
}

function minimalDeps(): RegistryDeps {
  return { servicenow: { safety: { denyTables: [], overrideTables: [] } } };
}

describe("mcp outputSchemas accept the documented return shapes", function () {
  it("servicenow_query_table → { table, count, records }", function () {
    assertValidates(servicenowQueryTableOutput, {
      table: "incident",
      count: 2,
      records: [{ sys_id: "a", number: "INC001" }, { sys_id: "b" }]
    });
  });

  it("servicenow_query_table tolerates an empty result", function () {
    assertValidates(servicenowQueryTableOutput, { table: "incident", count: 0, records: [] });
  });

  it("clickup_get_team_sync → TeamSyncJson", function () {
    assertValidates(clickupGetTeamSyncOutput, {
      syncTime: "2026-06-06T00:00:00.000Z",
      total: 3,
      totalLists: 2,
      stages: [
        {
          stage: "In Progress",
          count: 1,
          tasks: [
            {
              id: "1",
              customId: "DEV-1",
              name: "t",
              status: "open",
              url: "u",
              list: "L",
              assignees: ["a"],
              dueDate: null,
              dateUpdated: "x"
            }
          ]
        }
      ],
      unmappedStatuses: { weird: 1 },
      unassigned: []
    });
  });

  it("the two read tools declare outputSchema; a write tool does not", function () {
    var byName: Record<string, any> = {};
    buildDescriptorsForTests(minimalDeps()).forEach(function (d) {
      byName[d.name] = d;
    });
    expect(byName["servicenow_query_table"].outputSchema).toBeDefined();
    expect(byName["clickup_get_team_sync"].outputSchema).toBeDefined();
    expect(byName["clickup_update_task"].outputSchema).toBeUndefined();
  });
});

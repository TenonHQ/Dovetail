import { Sinc } from "@tenonhq/dovetail-types";
import { resolveConfigForScope } from "../config";

const baseConfig: Sinc.ScopedConfig = {
  sourceDirectory: "src",
  buildDirectory: "build",
  includes: {},
  excludes: {},
  tableOptions: {},
  refreshInterval: 30,
  scopes: {},
};

function withIncludes(overrides: Record<string, unknown>): Sinc.ScopedConfig {
  return {
    ...baseConfig,
    includes: overrides as Sinc.TablePropMap,
  };
}

describe("resolveConfigForScope - _readOnlyTables", () => {
  it("returns an empty list when _readOnlyTables is absent", () => {
    const cfg = withIncludes({ _tables: ["incident", "sys_hub_flow"] });
    const resolved = resolveConfigForScope("any_scope", cfg);
    expect(resolved.readOnlyTables).toEqual([]);
  });

  it("returns the global _readOnlyTables list when no scope override", () => {
    const cfg = withIncludes({
      _tables: ["incident", "sys_hub_flow"],
      _readOnlyTables: ["sys_hub_flow"],
    });
    const resolved = resolveConfigForScope("x_cadso_core", cfg);
    expect(resolved.readOnlyTables).toEqual(["sys_hub_flow"]);
  });

  it("unions global and scope _readOnlyTables without duplicates", () => {
    const cfg = withIncludes({
      _tables: ["incident", "sys_hub_flow", "sys_hub_action_instance"],
      _readOnlyTables: ["sys_hub_flow"],
      _scopes: {
        x_cadso_core: {
          _readOnlyTables: ["sys_hub_flow", "sys_hub_action_instance"],
        },
      },
    });
    const resolved = resolveConfigForScope("x_cadso_core", cfg);
    expect(resolved.readOnlyTables.sort()).toEqual(
      ["sys_hub_action_instance", "sys_hub_flow"].sort(),
    );
  });

  it("falls back to the global list for scopes without an override", () => {
    const cfg = withIncludes({
      _tables: ["incident", "sys_hub_flow"],
      _readOnlyTables: ["sys_hub_flow"],
      _scopes: {
        x_cadso_core: {
          _readOnlyTables: ["sys_hub_action_instance"],
        },
      },
    });
    const resolved = resolveConfigForScope("x_cadso_other", cfg);
    expect(resolved.readOnlyTables).toEqual(["sys_hub_flow"]);
  });

  it("ignores non-array _readOnlyTables values safely", () => {
    const cfg = withIncludes({
      _tables: ["incident"],
      _readOnlyTables: "oops-not-an-array" as unknown as string[],
    });
    const resolved = resolveConfigForScope("any_scope", cfg);
    expect(resolved.readOnlyTables).toEqual([]);
  });
});

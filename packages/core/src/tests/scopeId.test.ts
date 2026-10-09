// A scope argument that is a sys_scope sys_id goes to the server as-is: it is the only
// way to target a specific global-scope app, because every global app's scope name is
// "global". Anything else is a scope name and is resolved by name.

import { isScopeSysId } from "../scopeId";

describe("isScopeSysId", () => {
  test("accepts a 32-character lowercase hex sys_id", () => {
    expect(isScopeSysId("5f33b5d433d90b147b18bc534d5c7bf6")).toBe(true);
  });

  test("treats scope names, including global, as names", () => {
    expect(isScopeSysId("global")).toBe(false);
    expect(isScopeSysId("x_cadso_core")).toBe(false);
  });

  test("rejects near-misses: uppercase, wrong length, padding", () => {
    expect(isScopeSysId("5F33B5D433D90B147B18BC534D5C7BF6")).toBe(false);
    expect(isScopeSysId("5f33b5d433d90b147b18bc534d5c7bf")).toBe(false);
    expect(isScopeSysId(" 5f33b5d433d90b147b18bc534d5c7bf6")).toBe(false);
    expect(isScopeSysId("")).toBe(false);
  });
});

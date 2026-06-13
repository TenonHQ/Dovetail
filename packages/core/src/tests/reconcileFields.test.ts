// Tests for the field-comparison rules: metaData is excluded from the content
// diff; everything else is a comparable field with a stable "<name>.<type>" key.

import { fieldKey, isComparableField } from "../reconcile/fields";

describe("isComparableField", () => {
  it("excludes the metaData.json bookkeeping file", () => {
    expect(isComparableField({ name: "metaData", type: "json" })).toBe(false);
  });

  it("includes a real field file", () => {
    expect(isComparableField({ name: "script", type: "js" })).toBe(true);
  });

  it("includes a json field that is not metaData", () => {
    expect(isComparableField({ name: "composition", type: "json" })).toBe(true);
  });

  it("includes a field that happens to be named metaData but is not json", () => {
    expect(isComparableField({ name: "metaData", type: "txt" })).toBe(true);
  });
});

describe("fieldKey", () => {
  it("joins name and type", () => {
    expect(fieldKey({ name: "script", type: "js" })).toBe("script.js");
  });
});

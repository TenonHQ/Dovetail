import {
  parseAttributes,
  serializeAttributes,
  normalizeAttributeInput,
  mergeAttributes,
  missingAttributes,
  resolveColumnAttributes,
} from "../src/table";

describe("parseAttributes / serializeAttributes", function () {
  it("round-trips key=value pairs, bare keys, and '=' inside a value", function () {
    var raw =
      "ref_auto_completer=AJAXTableCompleter,no_sort,ref_qual_elements=a=b;c";
    var parsed = parseAttributes(raw);
    expect(parsed).toEqual([
      { key: "ref_auto_completer", value: "AJAXTableCompleter" },
      { key: "no_sort", value: null },
      { key: "ref_qual_elements", value: "a=b;c" },
    ]);
    expect(serializeAttributes(parsed)).toBe(raw);
  });
  it("is lenient with stored values: trims, skips empty entries, last duplicate wins in place", function () {
    expect(parseAttributes(" a=1 ,, b=2 , a=3 ")).toEqual([
      { key: "a", value: "3" },
      { key: "b", value: "2" },
    ]);
    expect(parseAttributes("")).toEqual([]);
  });
});

describe("normalizeAttributeInput", function () {
  it("accepts a string or a map (booleans become 'true'/'false')", function () {
    expect(normalizeAttributeInput("readonly_clickthrough=true")).toEqual([
      { key: "readonly_clickthrough", value: "true" },
    ]);
    expect(
      normalizeAttributeInput({
        readonly_clickthrough: true,
        ref_auto_completer: "X",
      }),
    ).toEqual([
      { key: "readonly_clickthrough", value: "true" },
      { key: "ref_auto_completer", value: "X" },
    ]);
  });
  it("rejects malformed keys, separators in values, stray commas, and empty input", function () {
    expect(function () {
      normalizeAttributeInput("9a=1");
    }).toThrow(/not a valid attribute name/);
    expect(function () {
      normalizeAttributeInput("a b=1");
    }).toThrow(/not a valid attribute name/);
    expect(function () {
      normalizeAttributeInput({ a: "1,2" });
    }).toThrow(/contains ','/);
    expect(function () {
      normalizeAttributeInput("a=1,");
    }).toThrow(/stray comma/);
    expect(function () {
      normalizeAttributeInput("  ");
    }).toThrow(/empty attribute string/);
    expect(function () {
      normalizeAttributeInput({});
    }).toThrow(/at least one attribute/);
  });
});

describe("mergeAttributes", function () {
  it("never drops an existing key; appends new ones; overwrites in place", function () {
    expect(
      mergeAttributes(
        "ref_auto_completer=X,no_sort",
        normalizeAttributeInput("readonly_clickthrough=true"),
      ),
    ).toBe("ref_auto_completer=X,no_sort,readonly_clickthrough=true");
    expect(
      mergeAttributes(
        "readonly_clickthrough=false,no_sort=true",
        normalizeAttributeInput("readonly_clickthrough=true"),
      ),
    ).toBe("readonly_clickthrough=true,no_sort=true");
    expect(mergeAttributes("", normalizeAttributeInput("a=1"))).toBe("a=1");
  });
});

describe("missingAttributes", function () {
  it("is order-insensitive and checks the value, not just the key", function () {
    var want = normalizeAttributeInput("readonly_clickthrough=true");
    expect(missingAttributes("x=1,readonly_clickthrough=true", want)).toEqual(
      [],
    );
    expect(missingAttributes("readonly_clickthrough=false", want)).toEqual([
      "readonly_clickthrough=true",
    ]);
    expect(missingAttributes("", want)).toEqual(["readonly_clickthrough=true"]);
  });
});

describe("resolveColumnAttributes", function () {
  it("defaults a reference column to readonly_clickthrough=true", function () {
    expect(serializeAttributes(resolveColumnAttributes("reference"))).toBe(
      "readonly_clickthrough=true",
    );
  });
  it("adds no default to a non-reference column", function () {
    expect(resolveColumnAttributes("string_full_utf8")).toEqual([]);
  });
  it("honours the opt-out", function () {
    expect(resolveColumnAttributes("reference", undefined, true)).toEqual([]);
  });
  it("lets an explicit readonly_clickthrough win over the default", function () {
    expect(
      serializeAttributes(
        resolveColumnAttributes("reference", "readonly_clickthrough=false"),
      ),
    ).toBe("readonly_clickthrough=false");
  });
  it("merges caller attributes with the default", function () {
    expect(
      serializeAttributes(
        resolveColumnAttributes("reference", "ref_auto_completer=X"),
      ),
    ).toBe("ref_auto_completer=X,readonly_clickthrough=true");
  });
});

import {
  READ_ONLY,
  WRITE_ADDITIVE_IDEMPOTENT,
  WRITE_CREATE,
  WRITE_OVERWRITE,
  WRITE_EXECUTE
} from "../annotations";

describe("annotation presets", function () {
  it("READ_ONLY is read-only", function () {
    expect(READ_ONLY.readOnlyHint).toBe(true);
  });

  it("WRITE_ADDITIVE_IDEMPOTENT — additive, idempotent", function () {
    expect(WRITE_ADDITIVE_IDEMPOTENT.readOnlyHint).toBe(false);
    expect(WRITE_ADDITIVE_IDEMPOTENT.destructiveHint).toBe(false);
    expect(WRITE_ADDITIVE_IDEMPOTENT.idempotentHint).toBe(true);
  });

  it("WRITE_CREATE — additive, non-idempotent", function () {
    expect(WRITE_CREATE.readOnlyHint).toBe(false);
    expect(WRITE_CREATE.destructiveHint).toBe(false);
    expect(WRITE_CREATE.idempotentHint).toBe(false);
  });

  it("WRITE_OVERWRITE — destructive, idempotent", function () {
    expect(WRITE_OVERWRITE.readOnlyHint).toBe(false);
    expect(WRITE_OVERWRITE.destructiveHint).toBe(true);
    expect(WRITE_OVERWRITE.idempotentHint).toBe(true);
  });

  it("WRITE_EXECUTE — destructive, non-idempotent", function () {
    expect(WRITE_EXECUTE.readOnlyHint).toBe(false);
    expect(WRITE_EXECUTE.destructiveHint).toBe(true);
    expect(WRITE_EXECUTE.idempotentHint).toBe(false);
  });

  it("the five presets are distinct objects", function () {
    var all = [READ_ONLY, WRITE_ADDITIVE_IDEMPOTENT, WRITE_CREATE, WRITE_OVERWRITE, WRITE_EXECUTE];
    for (var i = 0; i < all.length; i++) {
      for (var j = i + 1; j < all.length; j++) {
        expect(all[i]).not.toBe(all[j]);
      }
    }
  });
});

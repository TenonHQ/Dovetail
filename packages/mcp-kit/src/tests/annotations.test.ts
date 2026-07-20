import {
  READ_ONLY,
  WRITE_ADDITIVE_IDEMPOTENT,
  WRITE_CREATE,
  WRITE_OVERWRITE,
  WRITE_EXECUTE,
  WRITE_DESTRUCTIVE
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

  it("WRITE_DESTRUCTIVE — destructive, non-idempotent (schema hard-delete, S1-gated)", function () {
    expect(WRITE_DESTRUCTIVE.readOnlyHint).toBe(false);
    expect(WRITE_DESTRUCTIVE.destructiveHint).toBe(true);
    expect(WRITE_DESTRUCTIVE.idempotentHint).toBe(false);
  });

  it("WRITE_DESTRUCTIVE is a distinct object from WRITE_OVERWRITE", function () {
    // Its hint profile matches WRITE_EXECUTE, but it must be its own named tier so a
    // context-gated hard-delete never reads as a routine idempotent overwrite.
    expect(WRITE_DESTRUCTIVE).not.toBe(WRITE_OVERWRITE);
    expect(WRITE_DESTRUCTIVE.idempotentHint).not.toBe(WRITE_OVERWRITE.idempotentHint);
  });

  it("the six presets are distinct objects", function () {
    var all = [
      READ_ONLY,
      WRITE_ADDITIVE_IDEMPOTENT,
      WRITE_CREATE,
      WRITE_OVERWRITE,
      WRITE_EXECUTE,
      WRITE_DESTRUCTIVE
    ];
    for (var i = 0; i < all.length; i++) {
      for (var j = i + 1; j < all.length; j++) {
        expect(all[i]).not.toBe(all[j]);
      }
    }
  });
});

import { formatPromoteResult, formatPreviewErrors } from "../formatter";
import { PromoteResponse, PreviewError } from "../types";

function makePreviewError(overrides: Partial<PreviewError>): PreviewError {
  var base: PreviewError = {
    type: "PreviewProblem",
    message: "Could not find a target record",
  };
  return Object.assign({}, base, overrides);
}

function makePromoteResponse(overrides: Partial<PromoteResponse>): PromoteResponse {
  var base: PromoteResponse = {
    remoteUpdateSetSysId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    previewErrors: [],
    committed: true,
    elapsedMs: 4200,
  };
  return Object.assign({}, base, overrides);
}

describe("formatPromoteResult", function () {
  it("reports a committed result", function () {
    var result = makePromoteResponse({ committed: true });
    var text = formatPromoteResult(result);
    expect(text).toContain("committed");
    expect(text).not.toContain("not committed");
  });

  it("reports a preview-only (not committed) result", function () {
    var result = makePromoteResponse({ committed: false });
    var text = formatPromoteResult(result);
    expect(text).toContain("previewed (not committed)");
  });

  it("includes the remote update set sys_id", function () {
    var result = makePromoteResponse({
      remoteUpdateSetSysId: "deadbeefdeadbeefdeadbeefdeadbeef",
    });
    var text = formatPromoteResult(result);
    expect(text).toContain("Remote update set: deadbeefdeadbeefdeadbeefdeadbeef");
  });

  it("renders elapsedMs as seconds with one decimal", function () {
    var result = makePromoteResponse({ elapsedMs: 4200 });
    var text = formatPromoteResult(result);
    expect(text).toContain("Elapsed: 4.2s");
  });

  it("trims the trailing .0 for whole-second elapsed times", function () {
    var result = makePromoteResponse({ elapsedMs: 5000 });
    var text = formatPromoteResult(result);
    expect(text).toContain("Elapsed: 5s");
  });

  it("says preview errors: none when there are none", function () {
    var result = makePromoteResponse({ previewErrors: [] });
    var text = formatPromoteResult(result);
    expect(text).toContain("Preview errors: none");
  });

  it("includes a count and listing when preview errors are present", function () {
    var result = makePromoteResponse({
      committed: false,
      previewErrors: [
        makePreviewError({
          type: "PreviewProblem",
          message: "Skipped a colliding record",
          targetTable: "sys_script_include",
          targetName: "DovetailUtils",
          sysId: "11112222333344445555666677778888",
        }),
        makePreviewError({ type: "DataLoss", message: "Field will be deleted" }),
      ],
    });
    var text = formatPromoteResult(result);
    expect(text).toContain("Preview errors: 2");
    expect(text).toContain("[PreviewProblem] Skipped a colliding record");
    expect(text).toContain("table: sys_script_include");
    expect(text).toContain("name: DovetailUtils");
    expect(text).toContain("sys_id: 11112222333344445555666677778888");
    expect(text).toContain("[DataLoss] Field will be deleted");
  });

  it("handles an undefined elapsedMs gracefully", function () {
    var result = makePromoteResponse({});
    delete (result as Partial<PromoteResponse>).elapsedMs;
    var text = formatPromoteResult(result);
    expect(text).toContain("Elapsed: unknown");
  });
});

describe("formatPreviewErrors", function () {
  it("returns 'No preview errors' for an empty array", function () {
    expect(formatPreviewErrors([])).toBe("No preview errors");
  });

  it("renders type and message for each error", function () {
    var errors = [
      makePreviewError({ type: "PreviewProblem", message: "Target not found" }),
    ];
    var text = formatPreviewErrors(errors);
    expect(text).toContain("[PreviewProblem]");
    expect(text).toContain("Target not found");
  });

  it("includes the target when targetTable/targetName/sysId are present", function () {
    var errors = [
      makePreviewError({
        type: "Collision",
        message: "Record changed on both sides",
        targetTable: "sys_ui_action",
        targetName: "Submit",
        sysId: "abcabcabcabcabcabcabcabcabcabcab",
      }),
    ];
    var text = formatPreviewErrors(errors);
    expect(text).toContain("table: sys_ui_action");
    expect(text).toContain("name: Submit");
    expect(text).toContain("sys_id: abcabcabcabcabcabcabcabcabcabcab");
  });

  it("omits the target parenthetical when no target fields are set", function () {
    var errors = [makePreviewError({ type: "Info", message: "Nothing to preview" })];
    var text = formatPreviewErrors(errors);
    expect(text).toBe("  - [Info] Nothing to preview");
  });

  it("renders one line per error", function () {
    var errors = [
      makePreviewError({ type: "A", message: "first" }),
      makePreviewError({ type: "B", message: "second" }),
      makePreviewError({ type: "C", message: "third" }),
    ];
    var text = formatPreviewErrors(errors);
    expect(text.split("\n").length).toBe(3);
  });
});

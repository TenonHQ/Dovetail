import { parseClickUpIdentifier } from "../parser";

describe("parseClickUpIdentifier", function () {
  describe("raw task IDs", function () {
    it("parses a simple alphanumeric ID", function () {
      var result = parseClickUpIdentifier("abc123def");
      expect(result).toEqual({ taskId: "abc123def", raw: "abc123def" });
    });

    it("parses a realistic ClickUp ID", function () {
      var result = parseClickUpIdentifier("86a3bx7wz");
      expect(result).toEqual({ taskId: "86a3bx7wz", raw: "86a3bx7wz" });
    });

    it("parses an ID with hyphens", function () {
      var result = parseClickUpIdentifier("TASK-123");
      expect(result).toEqual({ taskId: "TASK-123", raw: "TASK-123" });
    });

    it("parses an ID with underscores", function () {
      var result = parseClickUpIdentifier("task_with_underscores");
      expect(result).toEqual({
        taskId: "task_with_underscores",
        raw: "task_with_underscores",
      });
    });

    it("parses a purely numeric ID", function () {
      var result = parseClickUpIdentifier("12345678");
      expect(result).toEqual({ taskId: "12345678", raw: "12345678" });
    });
  });

  describe("hash-prefixed IDs", function () {
    it("strips leading # from an ID", function () {
      var result = parseClickUpIdentifier("#abc123def");
      expect(result).toEqual({ taskId: "abc123def", raw: "#abc123def" });
    });

    it("strips # and trims whitespace", function () {
      var result = parseClickUpIdentifier("  #abc123  ");
      expect(result).toEqual({ taskId: "abc123", raw: "  #abc123  " });
    });
  });

  describe("short URLs", function () {
    it("extracts task ID from short URL format", function () {
      var result = parseClickUpIdentifier(
        "https://app.clickup.com/t/abc123def",
      );
      expect(result.taskId).toBe("abc123def");
      expect(result.raw).toBe("https://app.clickup.com/t/abc123def");
    });

    it("extracts task ID from short URL with realistic ID", function () {
      var result = parseClickUpIdentifier(
        "https://app.clickup.com/t/86a3bx7wz",
      );
      expect(result.taskId).toBe("86a3bx7wz");
    });

    it("handles short URL with trailing slash", function () {
      var result = parseClickUpIdentifier("https://app.clickup.com/t/abc123/");
      expect(result.taskId).toBe("abc123");
    });
  });

  describe("long URLs", function () {
    it("extracts task ID from long URL format", function () {
      var result = parseClickUpIdentifier(
        "https://app.clickup.com/12345678/v/dc/abcde-12345/86a3bx7wz",
      );
      expect(result.taskId).toBe("86a3bx7wz");
    });

    it("extracts last segment from long URL", function () {
      var result = parseClickUpIdentifier(
        "https://app.clickup.com/9999/v/li/900100/task123",
      );
      expect(result.taskId).toBe("task123");
    });
  });

  describe("whitespace handling", function () {
    it("trims leading and trailing spaces", function () {
      var result = parseClickUpIdentifier("  abc123  ");
      expect(result.taskId).toBe("abc123");
    });

    it("trims tabs and newlines", function () {
      var result = parseClickUpIdentifier("\tabc123\n");
      expect(result.taskId).toBe("abc123");
    });
  });

  describe("error cases", function () {
    it("throws on empty string", function () {
      expect(function () {
        parseClickUpIdentifier("");
      }).toThrow("ClickUp identifier is empty");
    });

    it("throws on whitespace-only string", function () {
      expect(function () {
        parseClickUpIdentifier("   ");
      }).toThrow("ClickUp identifier is empty");
    });

    it("throws on string with special characters", function () {
      expect(function () {
        parseClickUpIdentifier("abc@#$");
      }).toThrow("Could not parse ClickUp identifier");
    });

    it("throws on string with spaces in the middle", function () {
      expect(function () {
        parseClickUpIdentifier("abc 123");
      }).toThrow("Could not parse ClickUp identifier");
    });

    it("throws on URL with no extractable task ID path", function () {
      expect(function () {
        parseClickUpIdentifier("https://app.clickup.com/");
      }).toThrow();
    });
  });

  describe("edge cases", function () {
    it("handles URL with query parameters", function () {
      var result = parseClickUpIdentifier(
        "https://app.clickup.com/t/abc123?view=board",
      );
      expect(result.taskId).toBe("abc123");
    });

    it("handles single character ID", function () {
      var result = parseClickUpIdentifier("a");
      expect(result.taskId).toBe("a");
    });

    it("preserves original input as raw", function () {
      var input = "  #abc123  ";
      var result = parseClickUpIdentifier(input);
      expect(result.raw).toBe(input);
    });

    it("handles http (non-https) URLs", function () {
      var result = parseClickUpIdentifier("http://app.clickup.com/t/abc123");
      expect(result.taskId).toBe("abc123");
    });
  });
});

import { ParsedIdentifier } from "./types";

/**
 * @description Parses a ClickUp task identifier from a URL or raw ID.
 * @param input - A ClickUp task URL or raw task ID.
 * @returns Parsed identifier with the extracted taskId.
 *
 * @example
 * parseClickUpIdentifier("abc123def")
 * // => { taskId: "abc123def", raw: "abc123def" }
 *
 * parseClickUpIdentifier("https://app.clickup.com/t/abc123def")
 * // => { taskId: "abc123def", raw: "https://app.clickup.com/t/abc123def" }
 */
export function parseClickUpIdentifier(input: string): ParsedIdentifier {
  if (!input || input.trim() === "") {
    throw new Error(
      "ClickUp identifier is empty. Provide a task ID or ClickUp URL.",
    );
  }

  var cleaned = input.trim();

  // Strip leading # if present (e.g., "#abc123")
  if (cleaned.charAt(0) === "#") {
    cleaned = cleaned.substring(1);
  }

  // Handle URLs
  if (cleaned.indexOf("http") === 0) {
    return parseUrl(cleaned, input);
  }

  // Raw task ID — validate it's alphanumeric
  if (/^[a-zA-Z0-9_-]+$/.test(cleaned)) {
    return { taskId: cleaned, raw: input };
  }

  throw new Error(
    "Could not parse ClickUp identifier: '" +
      input +
      "'. Expected a task ID (alphanumeric) or ClickUp URL.",
  );
}

function parseUrl(url: string, raw: string): ParsedIdentifier {
  var parsed: URL;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error(
      "Invalid ClickUp URL: '" +
        url +
        "'. Expected a URL like https://app.clickup.com/t/<task-id>",
    );
  }

  var segments = parsed.pathname.split("/").filter(function (s) {
    return s !== "";
  });

  // Short URL format: https://app.clickup.com/t/<task-id>
  var tIndex = segments.indexOf("t");
  if (tIndex !== -1 && tIndex + 1 < segments.length) {
    return { taskId: segments[tIndex + 1], raw: raw };
  }

  // Long URL format: https://app.clickup.com/<team-id>/v/dc/<list-id>/<task-id>
  // The task ID is the last segment
  if (segments.length > 0) {
    var lastSegment = segments[segments.length - 1];
    // ClickUp task IDs in long URLs can contain alphanumeric chars and hyphens
    if (/^[a-zA-Z0-9_-]+$/.test(lastSegment)) {
      return { taskId: lastSegment, raw: raw };
    }
  }

  throw new Error(
    "Could not extract task ID from ClickUp URL: '" +
      url +
      "'. Expected a URL containing /t/<task-id> or ending with a task ID.",
  );
}

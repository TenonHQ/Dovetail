/**
 * Shared constants for Dovetail Google OAuth2 flow.
 */

export var DEFAULT_REDIRECT_PORT = 3000;
export var DEFAULT_REDIRECT_URI =
  "http://localhost:" + DEFAULT_REDIRECT_PORT + "/callback";

export var DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
];

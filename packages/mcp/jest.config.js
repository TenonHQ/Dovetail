module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testPathIgnorePatterns: [".js"],
  // sanitize-html pulls in ESM-only htmlparser2, which Jest cannot require.
  // See src/tests/__stubs__/sanitize-html.js.
  moduleNameMapper: {
    "^sanitize-html$": "<rootDir>/src/tests/__stubs__/sanitize-html.js"
  }
};

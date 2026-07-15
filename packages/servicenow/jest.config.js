module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // Ignore compiled output, not any path that merely contains "js". The bare ".js"
  // regex is unanchored — it also matches a checkout/worktree dir like ".../from-json/...",
  // silently skipping every test there. Anchor to a real ".js" file extension.
  testPathIgnorePatterns: ["\\.js$"],
};

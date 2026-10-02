"use strict";

// Jest-only stand-in for sanitize-html. sanitize-html >= 2.17.7 depends on
// htmlparser2 12, which is ESM-only; Node >= 22.12 loads it through native
// require(esm), but Jest's CommonJS module system cannot. dovetail-mcp tests
// reach sanitize-html only transitively (registry -> tools/gmail ->
// @tenonhq/dovetail-gmail) and never sanitize anything — tools.gmail.test.ts
// mocks the gmail client outright — so a call here means a test started
// depending on real sanitizing and should exercise it in dovetail-gmail instead.
module.exports = function sanitizeHtml() {
  throw new Error("sanitize-html is stubbed in dovetail-mcp tests (see jest.config.js moduleNameMapper)");
};

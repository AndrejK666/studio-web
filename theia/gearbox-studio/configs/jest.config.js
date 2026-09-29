// Unit tests for the rules that decide, not for the widgets that draw them:
// which folders hold products, which source a new product declares, where a
// git source is brought. Node, not jsdom -- none of them touch a document.
/** @type {import('jest').Config} */
module.exports = {
  rootDir: "../",
  testMatch: ["<rootDir>/src/**/*.test.ts"],
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
};

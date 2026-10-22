// OpenCode plugin entrypoint.
//
// OpenCode's plugin supervisor discovers package plugins through the
// `.opencode/plugins/` convention (see the superpowers package) and/or the
// package.json `main` field, which points here. The actual implementation
// lives in TypeScript one level up.
export { default } from "../../src/index.ts"
export * from "../../src/index.ts"

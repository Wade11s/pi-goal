/**
 * The extension's own release version (issue #55).
 *
 * Operational metrics report this so an operator can tell which pi-goal release
 * produced a record, without the projection having to reach into Pi state.
 *
 * It is a literal rather than an import of `package.json` because Pi loads the
 * extension as TypeScript source and JSON-module imports are not part of that
 * loader surface. `test/goal55-metrics-store.test.mjs` pins it to
 * `package.json`'s `version`, so a release that bumps one and not the other
 * fails the gate instead of shipping a wrong metrics value.
 */
export const PI_GOAL_VERSION = "0.2.0";

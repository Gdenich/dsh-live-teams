import { defineConfig } from 'vitest/config'

/**
 * The default five-second timeout is too tight for the suites that drive real git repositories: a
 * single test builds commits, reads trees and integrates branches, and under a full parallel run the
 * filesystem work pushes past five seconds — which showed up as three flaky timeouts in an external
 * review and again when the integration marker added two writes per acceptance. A slow test that
 * passes is information; a test that fails on the clock is noise.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})

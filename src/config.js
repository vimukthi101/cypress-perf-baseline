// src/config.js
// Single source of truth for all plugin configuration.
// All values can be overridden via env.perfBaseline in cypress.config.js
// or passed as options directly to cy.perfSnapshot().

const DEFAULT_CONFIG = {
  // Number of measurement samples per snapshot — median is stored.
  // More samples = more stable baseline but slower test run.
  samples: 3,

  // Milliseconds to wait after page load event before collecting metrics.
  // Gives lazy-loaded content, deferred scripts, and analytics time to fire.
  settleTime: 1500,

  // Milliseconds of zero network activity before the page is considered idle.
  networkIdleTime: 500,

  // Global regression threshold %.
  // A metric that is X% worse than baseline will fail the build.
  threshold: 20,

  // Per-metric thresholds — override the global threshold for specific metrics.
  // Tighter where you have control (JS size), looser where variance is expected (requests).
  thresholds: {
    LCP:             15,  // Largest Contentful Paint
    FCP:             15,  // First Contentful Paint
    TTFB:            20,  // Time to First Byte
    domInteractive:  20,  // DOM Interactive
    domComplete:     20,  // DOM Complete
    jsTransferKb:    10,  // JS bundle size — tightest, most controllable
    cssTransferKb:   20,  // CSS size
    imgTransferKb:   25,  // Image size
    totalTransferKb: 15,  // Total page weight
    requests:        30,  // Request count — looser, A/B tests can affect this
    longTaskCount:   50,  // Count varies; longTaskMs is more meaningful
    longTaskMs:      25,  // Total time blocked on main thread
    CLS:             25,  // Cumulative Layout Shift
  },

  // Where to write branch-aware baseline JSON files.
  // main branch → main.json, feature branches → <branch-name>.json
  baselineDir: 'cypress/perf-baselines',

  // Where to write the self-contained HTML report after each run.
  reportDir: 'cypress/perf-reports',

  // If true: process exits with code 1 when regressions are found (fails CI).
  // If false: report and warnings are generated but build continues.
  // Useful for rolling out the plugin before enforcing hard failures.
  failOnRegression: true,

  // Which metrics to collect. Remove any you don't need.
  metrics: [
    'LCP', 'FCP', 'CLS',
    'TTFB', 'domInteractive', 'domComplete', 'loadEvent',
    'dnsLookup', 'tcpConnect', 'tlsHandshake',
    'jsTransferKb', 'cssTransferKb', 'imgTransferKb', 'totalTransferKb',
    'requests', 'cachedRequests', 'slowestResourceMs',
    'longTaskCount', 'longTaskMs',
  ],

  // Mode is driven by the PERF_MODE environment variable.
  // 'record' → write a new baseline file (explicit opt-in action).
  // 'compare' → diff current run against baseline (default in CI).
  mode: process.env.PERF_MODE || 'compare',
}

/**
 * Merge user-provided overrides with defaults.
 * Called by tasks.js with the Cypress config.env object.
 */
function resolveConfig(cypressEnv = {}) {
  const overrides = cypressEnv.perfBaseline || {}
  const merged = { ...DEFAULT_CONFIG, ...overrides }
  // Deep merge thresholds so partial overrides don't wipe defaults
  merged.thresholds = {
    ...DEFAULT_CONFIG.thresholds,
    ...(overrides.thresholds || {}),
  }
  return merged
}

module.exports = { DEFAULT_CONFIG, resolveConfig }

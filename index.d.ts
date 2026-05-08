// Type definitions for cypress-perf-baseline
// Supports TypeScript projects using cy.perfSnapshot() and cy.perfAssert()

/// <reference types="cypress" />

declare module 'cypress-perf-baseline' {

  /** All metrics collected by the browser-side collector */
  export interface PerfMetrics {
    /** Largest Contentful Paint (ms) */
    LCP: number
    /** First Contentful Paint (ms) */
    FCP: number
    /** Cumulative Layout Shift score (3 decimal places) */
    CLS: number
    /** Time to First Byte (ms) */
    TTFB: number
    /** DOM Interactive (ms) */
    domInteractive: number
    /** DOM Complete (ms) */
    domComplete: number
    /** Load event end (ms) */
    loadEvent: number
    /** DNS lookup time (ms) */
    dnsLookup: number
    /** TCP connection time (ms) */
    tcpConnect: number
    /** TLS handshake time (ms) */
    tlsHandshake: number
    /** JavaScript transferred (KB, compressed) */
    jsTransferKb: number
    /** CSS transferred (KB) */
    cssTransferKb: number
    /** Images transferred (KB) */
    imgTransferKb: number
    /** Total page weight transferred (KB) */
    totalTransferKb: number
    /** Total network requests */
    requests: number
    /** Requests served from browser cache */
    cachedRequests: number
    /** Duration of the slowest request (ms) */
    slowestResourceMs: number
    /** Filename of the slowest request */
    slowestResourceName: string
    /** Number of main-thread tasks blocking > 50ms */
    longTaskCount: number
    /** Total duration of all long tasks (ms) */
    longTaskMs: number
    /** Backend timings from Server-Timing response headers */
    serverTiming: Record<string, number>
    /** Unix timestamp (ms) when metrics were collected */
    collectedAt: number
    /** Page URL at collection time */
    url: string
  }

  /** Per-metric threshold overrides (% regression allowance) */
  export interface PerfThresholds {
    LCP?: number
    FCP?: number
    CLS?: number
    TTFB?: number
    domInteractive?: number
    domComplete?: number
    loadEvent?: number
    dnsLookup?: number
    tcpConnect?: number
    tlsHandshake?: number
    jsTransferKb?: number
    cssTransferKb?: number
    imgTransferKb?: number
    totalTransferKb?: number
    requests?: number
    cachedRequests?: number
    slowestResourceMs?: number
    longTaskCount?: number
    longTaskMs?: number
    /** Any additional custom metric threshold */
    [metric: string]: number | undefined
  }

  /** Plugin-wide configuration (set via cypress.config.js env.perfBaseline) */
  export interface PerfBaselineConfig {
    /** Number of samples per snapshot — median is stored. Default: 3 */
    samples?: number
    /** Milliseconds to wait after page load before measuring. Default: 1500 */
    settleTime?: number
    /** Milliseconds of zero network activity = idle. Default: 500 */
    networkIdleTime?: number
    /** Global regression threshold %. Default: 20 */
    threshold?: number
    /** Per-metric threshold overrides */
    thresholds?: PerfThresholds
    /** Directory for baseline JSON files. Default: 'cypress/perf-baselines' */
    baselineDir?: string
    /** Directory for generated HTML reports. Default: 'cypress/perf-reports' */
    reportDir?: string
    /** Fail CI when regressions are found. Default: true */
    failOnRegression?: boolean
    /** List of metrics to collect */
    metrics?: string[]
    /** 'record' to save a new baseline, 'compare' to diff. Default: 'compare' */
    mode?: 'record' | 'compare'
  }

  /** Options passed to cy.perfSnapshot() */
  export interface PerfSnapshotOptions {
    /** Override sample count for this snapshot */
    samples?: number
    /** Override settle time (ms) for this snapshot */
    settleTime?: number
    /** Override network idle time (ms) for this snapshot */
    networkIdleTime?: number
    /** Override global regression threshold (%) for this snapshot */
    threshold?: number
    /** Override per-metric thresholds for this snapshot */
    thresholds?: PerfThresholds
    /**
     * Called before each sample — use for authentication.
     * @example
     * cy.perfSnapshot('dashboard', {
     *   beforeSnapshot: () => cy.login('user@test.com', 'pass')
     * })
     */
    beforeSnapshot?: () => void | Cypress.Chainable
  }

  /** Min/max budget for a single metric in cy.perfAssert() */
  export interface PerfBudget {
    /** Fail if metric value exceeds this */
    max?: number
    /** Fail if metric value falls below this */
    min?: number
  }

  /** Expectations map for cy.perfAssert() */
  export type PerfAssertExpectations = {
    [K in keyof Omit<PerfMetrics, 'slowestResourceName' | 'serverTiming' | 'url' | 'collectedAt'>]?: PerfBudget
  } & {
    [metric: string]: PerfBudget | undefined
  }

  /** Single metric comparison result from computeDiff */
  export interface PerfDiff {
    metric: string
    current: number
    baseline: number
    /** Rounded integer, e.g. +28 or -11 */
    pctChange: number
    /** Threshold that was applied for this metric */
    threshold: number
    status: 'regression' | 'improvement' | 'ok'
  }

  /** Value returned by the perfBaseline:snapshot task */
  export interface PerfSnapshotResult {
    name: string
    mode: 'record' | 'compare'
    diff: PerfDiff[] | null
    regressions: PerfDiff[]
    improvements: PerfDiff[]
    metrics: PerfMetrics
  }

  /**
   * Register the plugin's Node.js tasks and after:run hook with Cypress.
   *
   * **Must be called inside `setupNodeEvents` in `cypress.config.js`.**
   *
   * @example
   * // cypress.config.js
   * const { defineConfig } = require('cypress')
   * const { perfTasks }    = require('cypress-perf-baseline')
   *
   * module.exports = defineConfig({
   *   e2e: {
   *     setupNodeEvents(on, config) {
   *       perfTasks(on, config)
   *       return config
   *     }
   *   }
   * })
   */
  export function perfTasks(
    on: Cypress.PluginEvents,
    config: Cypress.PluginConfigOptions
  ): void
}

// ─── Cypress command augmentation ────────────────────────────────────────────

declare namespace Cypress {
  interface Chainable {
    /**
     * Measure the performance of the current page.
     *
     * Runs N samples (median stored), diffs against the branch baseline, and
     * fails the build when any metric regresses beyond its configured threshold.
     *
     * **Call after the page is fully loaded and key elements are visible.**
     *
     * @param name  Unique snapshot identifier committed to your baseline JSON.
     *              Use a stable, human-readable name — it is the key in the JSON.
     * @param options Optional per-snapshot overrides for samples, thresholds, auth.
     *
     * @example
     * cy.visit('/')
     * cy.get('[data-cy=hero]').should('be.visible')
     * cy.perfSnapshot('homepage')
     *
     * @example
     * cy.perfSnapshot('checkout', {
     *   samples: 5,
     *   threshold: 10,
     *   beforeSnapshot: () => cy.login('user@test.com', 'pass')
     * })
     */
    perfSnapshot(
      name: string,
      options?: import('cypress-perf-baseline').PerfSnapshotOptions
    ): Chainable

    /**
     * Assert that the last snapshot for `name` meets hard metric budgets,
     * independent of any stored baseline.
     *
     * Must be called after `cy.perfSnapshot(name)` in the same test.
     *
     * @param name         Must match the name used in a prior cy.perfSnapshot() call.
     * @param expectations Map of metric → { max?, min? } budget.
     *
     * @example
     * cy.perfAssert('homepage', {
     *   LCP:          { max: 1000 },
     *   jsTransferKb: { max: 400 },
     *   requests:     { max: 15 }
     * })
     */
    perfAssert(
      name: string,
      expectations: import('cypress-perf-baseline').PerfAssertExpectations
    ): Chainable
  }
}

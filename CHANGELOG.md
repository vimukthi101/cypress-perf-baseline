# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0]  - Initial public release with core performance snapshot and assertion features, baseline management, and reporting capabilities.

### Added

**Core features**
- `cy.perfSnapshot(name, options?)` to collect page metrics, store medians, compare against branch baselines, and flag regressions
- `cy.perfAssert(name, expectations)` for fixed performance budgets independent of baseline comparisons
- `perfTasks(on, config)` for task registration (`perfBaseline:snapshot`, `perfBaseline:getLastSnapshot`) and `after:run` report generation

**Metrics collected (18 total)**
- Core Web Vitals: LCP, FCP, CLS
- Navigation Timing: TTFB, domInteractive, domComplete, loadEvent
- Connection: dnsLookup, tcpConnect, tlsHandshake
- Resources: jsTransferKb, cssTransferKb, imgTransferKb, totalTransferKb, requests, cachedRequests, slowestResourceMs
- Long Tasks: longTaskCount, longTaskMs
- Server-Timing header passthrough

**Baseline system**
- Branch-aware JSON files in `cypress/perf-baselines/`
- `main.json` as primary; feature branches fall back to `main.json` automatically
- `PERF_MODE=record` to lock in a new baseline
- Per-metric threshold overrides on top of a global threshold

**Reporting**
- Self-contained HTML report with Chart.js trend charts
- `scripts/inline-chartjs.js` to inline Chart.js for fully offline reports and environments with CDN restrictions

**Quality**
- Zero-dependency Node.js test suite (`npm test`) — 29 tests
- End-to-end integration coverage:
  - `cypress.config.js` for local integration execution
  - `cypress/e2e/perf.cy.js` coverage for `cy.perfSnapshot()` and `cy.perfAssert()`
  - `cypress/support/e2e.js` local command registration
  - `example/index.html` deterministic static page used by integration tests
- GitHub Actions CI workflow in `.github/workflows/ci.yml`:
   - unit tests on Node 20/22/24
     - Cypress integration run in Chrome that records then compares against a generated baseline
- `serve:example` npm script for quickly running local integration tests
- TypeScript type definitions (`index.d.ts`) for `perfSnapshot`, `perfAssert`, `perfTasks`, and all supporting interfaces
- SRI hash on Chart.js CDN tag (`sha512`)
- `engines: { node: ">=16.0.0" }`, `peerDependencies: { cypress: ">=12.0.0" }`

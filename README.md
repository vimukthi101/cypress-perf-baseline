# cypress-perf-baseline

[![CI](https://github.com/vimukthi101/cypress-perf-baseline/actions/workflows/tests.yml/badge.svg?branch=master)](https://github.com/vimukthi101/cypress-perf-baseline/actions/workflows/tests.yml)

> Measure performance in Cypress tests, keep a baseline in git, and catch regressions in CI.

No external service is required. Baselines are plain JSON files in your repo, and each run produces an HTML report.

---

## Why

If you already track frontend performance manually, this plugin makes the process repeatable in tests. Add `cy.perfSnapshot('page-name')` where the page is stable, and it will:

- store measurable baselines for comparison
- fail CI when a metric crosses its threshold
- generate an HTML report with diffs and trends

---

## Install

```bash
npm install --save-dev cypress-perf-baseline
```

This package includes the `cypress-plugin` keyword for Cypress plugin discovery.

---

## Setup (2 files)

### `cypress.config.js`

```js
const { defineConfig } = require('cypress')
const { perfTasks }    = require('cypress-perf-baseline')

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      perfTasks(on, config)
      return config
    },

    env: {
      // All options are optional — these are the defaults
      perfBaseline: {
        samples:          3,      // measurements per page — median is stored
        settleTime:       1500,   // ms after load before collecting
        networkIdleTime:  500,    // ms of silence = page idle
        threshold:        20,     // global regression % threshold
        failOnRegression: true,   // set false to warn only
        baselineDir:      'cypress/perf-baselines',
        reportDir:        'cypress/perf-reports',
        thresholds: {             // per-metric overrides
          jsTransferKb:   10,     // tight — you control this
          LCP:            15,
          FCP:            15,
          requests:       30,     // looser — A/B tests affect this
        }
      }
    }
  }
})
```

### `cypress/support/e2e.js`

```js
require('cypress-perf-baseline/src/commands')
```

---

## Write tests

```js
// cypress/e2e/perf/site-perf.cy.js

describe('site performance', () => {

  // Public page — just visit and snapshot
  it('measures homepage', () => {
    cy.visit('/')
    cy.get('[data-cy=hero]').should('be.visible')
    cy.perfSnapshot('homepage')
  })

  // Authenticated page — pass a beforeSnapshot hook
  it('measures checkout', () => {
    cy.visit('/checkout')
    cy.perfSnapshot('checkout', {
      beforeSnapshot: () => cy.login('test@example.com', 'pass')
    })
  })

  // Hard budget — fail if LCP exceeds 1000ms regardless of baseline
  it('homepage meets budget', () => {
    cy.visit('/')
    cy.perfSnapshot('homepage')
    cy.perfAssert('homepage', {
      LCP:          { max: 1000 },
      jsTransferKb: { max: 400 },
      requests:     { max: 15 }
    })
  })

})
```

---

## Record a baseline

Run this once after your perf work to lock in the numbers:

```bash
PERF_MODE=record npx cypress run --spec "cypress/e2e/perf/**"
```

Writes `cypress/perf-baselines/main.json`. **Commit this file.**

---

## Compare on every run (default)

```bash
npm run test:integration:compare
```

Example output (all metrics pass — no regressions):

```
 - [perf] "example-page-full-load"
  ────────────────────────────────────────────────────────────
    TTFB                       7  was        6 (+17%)    → ok
    domInteractive            12  was       13 (-8%)     → ok
    domComplete               12  was       13 (-8%)     → ok
    loadEvent                 13  was       13 (0%)      → ok
    totalTransferKb            2  was        2 (0%)      → ok
    requests                   1  was        1 (0%)      → ok
    LCP                       56  was       60 (-7%)     → ok
    FCP                       56  was       60 (-7%)     → ok

  -  "example-page-full-load" — all metrics within thresholds

 - [perf] "example-page"
  ────────────────────────────────────────────────────────────
    TTFB                       6  was        7 (-14%)    → ok
    domInteractive            12  was       12 (0%)      → ok
    domComplete              177  was      177 (0%)      → ok
    loadEvent                177  was      178 (-1%)     → ok
    totalTransferKb            2  was        2 (0%)      → ok
    requests                   1  was        1 (0%)      → ok
    LCP                      204  was      204 (0%)      → ok
    FCP                      204  was      204 (0%)      → ok
    longTaskCount              1  was        1 (0%)      → ok
    longTaskMs               164  was      163 (+1%)     → ok

  -  "example-page" — all metrics within thresholds

 - [perf] "example-page-budget"
  ────────────────────────────────────────────────────────────
    TTFB                       6  was        7 (-14%)    → ok
    domInteractive            12  was       13 (-8%)     → ok
    domComplete              180  was      186 (-3%)     → ok
    loadEvent                180  was      186 (-3%)     → ok
    totalTransferKb            2  was        2 (0%)      → ok
    requests                   1  was        1 (0%)      → ok
    LCP                      208  was      224 (-7%)     → ok
    FCP                      208  was      224 (-7%)     → ok
    longTaskCount              1  was        1 (0%)      → ok
    longTaskMs               167  was      170 (-2%)     → ok

  -  "example-page-budget" — all metrics within thresholds

  [cypress-perf-baseline] Run complete (21.8s)
  Snapshots: 3  |  Regressions: 0
  Report → cypress/integration-reports/perf-report.html
  All metrics within thresholds — no regressions.
```

---

## `cy.perfSnapshot(name, options?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `samples` | `number` | `3` | Sample count — median is stored |
| `settleTime` | `number` | `1500` | ms to wait after load before measuring |
| `networkIdleTime` | `number` | `500` | ms of silence before collecting |
| `threshold` | `number` | `20` | Regression % for this snapshot |
| `thresholds` | `object` | config | Per-metric thresholds for this snapshot |
| `beforeSnapshot` | `function` | — | Runs before each sample (use for login) |

## `cy.perfAssert(name, expectations)`

Hard-assert on absolute values regardless of baseline:

```js
cy.perfAssert('checkout', {
  LCP:          { max: 1200 },
  TTFB:         { max: 200 },
  jsTransferKb: { max: 500 },
})
```

---

## Metrics collected

| Metric | Description |
|--------|-------------|
| `LCP` | Largest Contentful Paint |
| `FCP` | First Contentful Paint |
| `CLS` | Cumulative Layout Shift |
| `TTFB` | Time to First Byte |
| `domInteractive` | DOM ready |
| `domComplete` | Full page load |
| `dnsLookup` | DNS resolution time |
| `tcpConnect` | TCP connection time |
| `tlsHandshake` | TLS negotiation time |
| `jsTransferKb` | JavaScript bytes (compressed) |
| `cssTransferKb` | CSS bytes |
| `imgTransferKb` | Image bytes |
| `totalTransferKb` | Total page weight |
| `requests` | Total network requests |
| `cachedRequests` | Requests from cache |
| `slowestResourceMs` | Duration of slowest request |
| `longTaskCount` | Main-thread tasks > 50ms |
| `longTaskMs` | Total duration of long tasks |
| `serverTiming` | Backend timings (Server-Timing header) |

---

## Environment variables

| Variable | Values | Description |
|----------|--------|-------------|
| `PERF_MODE` | `record` / `compare` | `record` saves a new baseline. Default: `compare` |
| `BRANCH_NAME` | string | Branch name for baseline file naming. Set by most CI systems automatically. |

---

## Files written

```
cypress/
  perf-baselines/
    main.json              ← commit this to git
    my-branch.json         ← auto-created for feature branches
  perf-reports/
    perf-report.html       ← generated each run — add to .gitignore
```

`.gitignore`:
```
cypress/perf-reports/
```

For this repo's own integration tests, generated files are written to:

```text
cypress/integration-baselines/
cypress/integration-reports/
```

---


## How baselines work

- Baseline JSON files live in `cypress/perf-baselines/` and are committed to git
- `main.json` is the primary baseline — all PRs compare against it
- Feature branches get their own file (`feat-my-change.json`) auto-created when you run `PERF_MODE=record` on that branch
- If no branch-specific file exists, the plugin falls back to `main.json`
- To update the baseline after intentional perf work: run `PERF_MODE=record`, review the numbers, commit the updated JSON

---

## Contributing / development

```bash
# Clone and install
git clone https://github.com/vimukthi101/cypress-perf-baseline
cd cypress-perf-baseline
npm install

# Run the unit test suite (no browser needed — pure Node.js)
npm test

# Run integration tests against the example page (Chrome for better LCP coverage)
npm run test:integration:record
npm run test:integration:compare

# Inline Chart.js for fully offline reports
npm run inline-chartjs
```

Tests live in `test/run.js` (29 unit tests, no external runner) and `cypress/e2e/perf.cy.js` (integration tests that run against the local example server).

```bash
$ npm test
...
 - config -
- resolveConfig: defaults are applied
- resolveConfig: user overrides win
 ... (unit tests for all components)
 - 29 passed, 0 failed
```

## CI workflow

This repository includes `.github/workflows/ci.yml` with two jobs:

- `unit-tests` — runs `npm test` on Node 20/22/24
- `integration-tests` — serves `example/index.html`, runs Cypress in Chrome in `record`, then `compare` mode

The integration job uploads `cypress/integration-reports/perf-report.html` as an artifact.

## Cypress plugin-list readiness

If you want to list this package on the official Cypress plugins page, this repo already includes the expected basics:

- clear purpose + setup docs in `README.md`
- integration tests with Cypress in `cypress/e2e/perf.cy.js`
- CI pipeline in `.github/workflows/tests.yml`
- populated package metadata in `package.json` (`homepage`, `repository`, `bugs`, keywords)

After publishing to npm, you can submit a PR to the Cypress docs repo and add an entry to `src/data/plugins.json`.

---

## License

[MIT](./LICENSE) © 2026 Vimukthi Saranga

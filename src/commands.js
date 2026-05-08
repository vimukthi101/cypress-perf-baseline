// src/commands.js
// Registers cy.perfSnapshot() and cy.perfAssert() Cypress commands.
//
// Add to cypress/support/e2e.js:
//   require('cypress-perf-baseline/src/commands')

const collectMetricsSrc = require('./collector')

// cy.perfSnapshot(name, options?)
//
// Measures the performance of the current page. Handles:
//   - Warm-up visit (not counted as a sample)
//   - N sample runs with median computation
//   - Cache clearing between samples (cookies, localStorage, browser disk cache)
//   - Network idle detection before collecting
//   - Optional beforeSnapshot hook for authentication
//
// Usage:
//   cy.visit('/products')
//   cy.get('[data-cy=grid]').should('be.visible')
//   cy.perfSnapshot('product-listing')
//
//   // With auth:
//   cy.perfSnapshot('checkout', {
//     beforeSnapshot: () => cy.login('user@test.com', 'pass')
//   })
//
//   // With custom options:
//   cy.perfSnapshot('homepage', {
//     samples: 5,
//     threshold: 10,
//     thresholds: { jsTransferKb: 5 }
//   })
Cypress.Commands.add('perfSnapshot', (name, options = {}) => {
  if (!name || typeof name !== 'string') {
    throw new Error('! [cypress-perf-baseline] cy.perfSnapshot() requires a string name as first argument')
  }

  // Resolve config: plugin defaults → cypress.config env overrides → per-call options
  const envCfg = Cypress.env('perfBaseline') || {}
  const samples= resolvePositiveIntOption(options.samples, envCfg.samples, 3, 'samples')
  const settleTime = resolveNonNegativeOption(options.settleTime, envCfg.settleTime, 1500, 'settleTime')
  const idleTime = resolveNonNegativeOption(options.networkIdleTime, envCfg.networkIdleTime, 500, 'networkIdleTime')
  const threshold = resolveNonNegativeOption(options.threshold, envCfg.threshold, 20, 'threshold')
  const thresholds = Object.assign({}, envCfg.thresholds || {}, options.thresholds || {})
  const beforeSnap= options.beforeSnapshot || null

  if (beforeSnap && typeof beforeSnap !== 'function') {
    throw new Error('! [cypress-perf-baseline] beforeSnapshot must be a function when provided')
  }

  // Capture current URL before warm-up so we re-visit consistently
  let targetUrl = ''
  cy.url().then(url => { targetUrl = url })

  const allSamples = []

  // Helper: clear all browser caches between samples
  // Ensures each sample is a consistent cold-ish load rather than measuring cached resources from the previous sample.
  const clearCaches = () => {
    cy.clearCookies()
    cy.clearLocalStorage()
    cy.window().then(win => { win.sessionStorage.clear() })
    // Clear browser disk + memory cache via Chrome DevTools Protocol
    cy.wrap(null, { log: false }).then(() => {
      return Cypress.automation('remote:debugger:protocol', {
        command: 'Network.clearBrowserCache',
      }).catch(() => {
        // Silently ignore — not supported in all Cypress/browser combos
      })
    })
  }

  // Helper: wait for network to go idle
  // Patches both XMLHttpRequest.send AND window.fetch to track in-flight requests. Resolves when no requests fire for
  // `idleTime` ms, or after a 5s hard cap. Modern SPAs use fetch almost exclusively, so patching only XHR would declare
  // idle while requests are still in-flight.
  const waitForIdle = () => {
    cy.window().then(win => {
      return new Cypress.Promise(resolve => {
        let timer = null
        let hardCap = null
        let finished = false
        let pending = 0

        const xhrProto = win.XMLHttpRequest && win.XMLHttpRequest.prototype
        const origSend = xhrProto && xhrProto.send
        const origFetch = typeof win.fetch === 'function' ? win.fetch : null

        function cleanup() {
          clearTimeout(timer)
          clearTimeout(hardCap)
          if (xhrProto && origSend) xhrProto.send = origSend
          if (origFetch) win.fetch = origFetch
        }

        function finish() {
          if (finished) return
          finished = true
          cleanup()
          resolve()
        }

        function bump() {
          clearTimeout(timer)
          if (pending === 0) timer = setTimeout(finish, idleTime)
        }
        function inc() { pending++; clearTimeout(timer) }
        function dec() { pending = Math.max(0, pending - 1); bump() }

        // Patch XHR
        if (xhrProto && origSend) {
          xhrProto.send = function(...args) {
            inc()
            this.addEventListener('loadend', dec, { once: true })
            return origSend.apply(this, args)
          }
        }

        // Patch fetch — critical for React/Vue/Angular apps
        if (origFetch) {
          win.fetch = function(...args) {
            inc()
            return origFetch.apply(win, args).then(
              result => {
                dec()
                return result
              },
              err => {
                dec()
                throw err
              }
            )
          }
        }

        // Start timer immediately — resolves after idleTime if already idle
        bump()
        // Hard cap: never wait more than 5 seconds
        hardCap = setTimeout(finish, 5000)
      })
    })
  }

  // Helper: take one measurement sample
  const takeSample = (idx) => {
    cy.log(`- [perf] "${name}" — sample ${idx + 1}/${samples}`)

    clearCaches()

    // Run auth/setup hook before each sample if provided
    if (beforeSnap) cy.then(() => beforeSnap())

    // Re-visit the page fresh for each sample
    cy.then(() => cy.visit(targetUrl))

    // Wait for page to settle: fixed time + network idle
    cy.wait(settleTime)
    waitForIdle()

    // Inject collector function into browser and execute it
    cy.window().then(win => {
      return new Cypress.Promise((resolve, reject) => {
        const fn = new win.Function(`return (${collectMetricsSrc})()`)
        fn().then(metrics => {
          allSamples.push(metrics)
          resolve(metrics)
        }).catch(reject)
      })
    })
  }

  // Warm-up: visit once without measuring
  // Primes DNS, TCP connections, and browser JIT compilation. Not counted as a sample — just gets the browser into a realistic state.
  cy.then(() => {
    cy.log(`- [perf] "${name}"— warming up (not measured)`)
    if (beforeSnap) cy.then(() => beforeSnap())
    cy.visit(targetUrl)
    cy.wait(800)
  })

  // Take N samples
  Cypress._.times(samples, i => takeSample(i))

  // Compute medians and send to Node layer
  cy.then(() => {
    const medians = computeMedians(allSamples)

    cy.log(
      `- [perf] "${name}" — ` +
      `LCP: ${medians.LCP}ms  ` +
      `FCP: ${medians.FCP}ms  ` +
      `JS: ${medians.jsTransferKb}kb  ` +
      `Requests: ${medians.requests}`
    )

    const snapshotData = {
      name,
      url: targetUrl,
      metrics: medians,
      // NOTE: raw samples are intentionally NOT sent to cy.task().
      // Sending full sample arrays (100+ resource entries × N samples) can
      // exceed Cypress's IPC serialisation limit (~1MB). The Node layer only
      // needs the computed medians — raw samples are only useful client-side
      // for debugging, which can be done via cy.log above.
      sampleCount: samples,
      threshold,
      thresholds,
      recordedAt: new Date().toISOString(),
      // BRANCH_NAME must come from Cypress.env() only — process.env is Node-only
      // and throws ReferenceError in browser context. Set via cypress.config.js
      // env.BRANCH_NAME or CYPRESS_BRANCH_NAME environment variable.
      branch: Cypress.env('BRANCH_NAME') || 'main',
    }

    // Hand off to Node layer (tasks.js) for baseline read/write/diff
    cy.task('perfBaseline:snapshot', snapshotData)
  })
})

// cy.perfAssert(name, expectations)
//
// Hard-assert on absolute metric values — independent of the baseline.
// Use when you have a known performance budget that must never be exceeded
// regardless of what the baseline says.
//
// Usage:
//   cy.perfAssert('homepage', {
//     LCP:          { max: 1000 },
//     jsTransferKb: { max: 400 },
//     requests:     { max: 15 }
//   })
Cypress.Commands.add('perfAssert', (name, expectations = {}) => {
  if (!name) throw new Error('! [cypress-perf-baseline] cy.perfAssert() requires a name argument')

  cy.task('perfBaseline:getLastSnapshot', { name }).then(snapshot => {
    if (!snapshot) {
      throw new Error(
        `! [cypress-perf-baseline] No snapshot found for "${name}". ` +
        `Run cy.perfSnapshot("${name}") before cy.perfAssert().`
      )
    }

    const failures = []

    Object.entries(expectations).forEach(([metric, rule]) => {
      const actual = snapshot.metrics[metric]
      if (actual === undefined || actual === null) return

      if (rule.max !== undefined && actual > rule.max) {
        failures.push(`  ${metric}: ${actual} exceeds max ${rule.max}`)
      }
      if (rule.min !== undefined && actual < rule.min) {
        failures.push(`  ${metric}: ${actual} is below min ${rule.min}`)
      }
    })

    if (failures.length) {
      throw new Error(
        `! [cypress-perf-baseline] cy.perfAssert("${name}") failed:\n` +
        failures.join('\n')
      )
    }

    cy.log(`- [perf] cy.perfAssert("${name}") — all budgets met`)
  })
})

// Utility: compute per-metric medians across N sample objects
function computeMedians(samples) {
  if (!samples.length) return {}

  const numericKeys = Object.keys(samples[0]).filter(
    k => typeof samples[0][k] === 'number'
  )

  const medians = {}

  numericKeys.forEach(key => {
    const vals = samples
      .map(s => s[key])
      .filter(v => typeof v === 'number' && !isNaN(v))
      .sort((a, b) => a - b)

    if (!vals.length) return

    const mid = Math.floor(vals.length / 2)
    medians[key] = vals.length % 2 === 0
      ? Math.round((vals[mid - 1] + vals[mid]) / 2)
      : vals[mid]
  })

  // Preserve non-numeric fields from the first sample
  if (samples[0].slowestResourceName) {
    medians.slowestResourceName = samples[0].slowestResourceName
  }
  if (samples[0].serverTiming) {
    medians.serverTiming = samples[0].serverTiming
  }
  if (samples[0].url) {
    medians.url = samples[0].url
  }

  return medians
}

function resolvePositiveIntOption(optionValue, envValue, fallback, optionName) {
  const value = firstDefined(optionValue, envValue, fallback)

  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`! [cypress-perf-baseline] ${optionName} must be a number greater than or equal to 1`)
  }

  return Math.round(value)
}

function resolveNonNegativeOption(optionValue, envValue, fallback, optionName) {
  const value = firstDefined(optionValue, envValue, fallback)

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`! [cypress-perf-baseline] ${optionName} must be a number greater than or equal to 0`)
  }

  return value
}

function firstDefined() {
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i] !== undefined && arguments[i] !== null) return arguments[i]
  }
  return undefined
}

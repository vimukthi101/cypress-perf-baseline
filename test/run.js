#!/usr/bin/env node
// test/run.js — lightweight Node.js test suite (no external test runner needed).
// Run with:  npm test  or  node test/run.js

'use strict'

const fs= require('fs')
const os= require('os')
const path = require('path')

// Tiny test harness
let passed = 0
let failed = 0

function test(label, fn) {
  try {
    fn()
    console.log(`- ${label}`)
    passed++
  } catch (err) {
    console.error(`! ${label}`)
    console.error(` ${err.message}`)
    failed++
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '! Assertion failed')
}

function assertEqual(a, b, message) {
  if (a !== b) throw new Error(message || `! Expected ${JSON.stringify(a)} === ${JSON.stringify(b)}`)
}

function assertContains(haystack, needle) {
  if (!haystack.includes(needle)) throw new Error(`! Expected string to contain:\n  ${needle}`)
}

function assertThrows(fn, pattern) {
  let threw = false
  let msg= ''
  try { fn() } catch (e) { threw = true; msg = e.message }
  if (!threw) throw new Error('! Expected function to throw but it did not')
  if (pattern && !pattern.test(msg)) throw new Error(`! Error message "${msg}" did not match ${pattern}`)
}

// Helpers
const { resolveConfig } = require('../src/config')
const { generateReport } = require('../src/report-generator')
const perfTasks= require('../src/tasks')
const collectorSrc= require('../src/collector')

// Build a minimal snapshot object suitable for generateReport / task calls
function makeSnap(overrides = {}) {
  return Object.assign({
    name: 'homepage',
    url: 'https://example.com/',
    branch: 'main',
    sampleCount: 3,
    recordedAt: new Date().toISOString(),
    threshold: 20,
    thresholds: {},
    metrics: {
      LCP: 900, FCP: 400, TTFB: 110,
      domInteractive: 220, domComplete: 400,
      jsTransferKb: 50, cssTransferKb: 12, imgTransferKb: 20, totalTransferKb: 90,
      requests: 10, cachedRequests: 7,
      longTaskCount: 2, longTaskMs: 120,
      CLS: 0.05,
      dnsLookup: 5, tcpConnect: 10, tlsHandshake: 15,
      slowestResourceMs: 320, slowestResourceName: 'bundle.js',
    },
    baselineMetrics: null,
    diff: null,
    regressions: [],
    improvements: [],
    hasRegression: false,
  }, overrides)
}

// Register perfTasks and return { task, afterRun } handler maps
function registerTasks(opts = {}) {
  const tmpDir= fs.mkdtempSync(path.join(os.tmpdir(), 'cpb-test-'))
  const baselineDir= path.join(tmpDir, 'baselines')
  const reportDir= path.join(tmpDir, 'reports')
  fs.mkdirSync(baselineDir)
  fs.mkdirSync(reportDir)

  const handlers = {}
  perfTasks(
    (event, handler) => { handlers[event] = handler },
    {
      env: Object.assign(
        { BRANCH_NAME: 'main' },
        opts.env || {},
        {
          // Always deep-merge perfBaseline so caller options augment (not replace) baselineDir/reportDir
          perfBaseline: Object.assign(
            { baselineDir, reportDir },
            (opts.env && opts.env.perfBaseline) || {}
          )
        }
      )
    }
  )
  return { handlers, tmpDir, baselineDir, reportDir }
}

// Tests — config
console.log('\n - config -')

test('resolveConfig: defaults are applied', () => {
  const cfg = resolveConfig({})
  assertEqual(cfg.samples, 3)
  assertEqual(cfg.threshold, 20)
  assertEqual(cfg.failOnRegression, true)
})

test('resolveConfig: user overrides win', () => {
  const cfg = resolveConfig({ perfBaseline: { samples: 5, threshold: 10 } })
  assertEqual(cfg.samples, 5)
  assertEqual(cfg.threshold, 10)
})

test('resolveConfig: per-metric threshold deep merge', () => {
  const cfg = resolveConfig({ perfBaseline: { thresholds: { LCP: 5 } } })
  assertEqual(cfg.thresholds.LCP, 5)
  assert(cfg.thresholds.TTFB > 0, 'Default TTFB threshold should survive a partial override')
})

test('resolveConfig: mode comes from env.perfBaseline when provided', () => {
  // process.env.PERF_MODE is evaluated at module load — use the config override path instead
  const cfg = resolveConfig({ perfBaseline: { mode: 'record' } })
  assertEqual(cfg.mode, 'record')
})

// Tests - diff computation (via task internals)
console.log('\n - diff computation -')

test('compare mode: regression detected when metric exceeds threshold', () => {
  // Set up a baseline first, then compare against it
  const { handlers: rec, baselineDir } = registerTasks({
    env: { perfBaseline: { mode: 'record' } }
  })

  rec.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {},
    metrics: { LCP: 1000, TTFB: 100 }
  })

  // Now compare with a regressed value against the recorded baseline
  const { handlers: cmp } = registerTasks({
    env: { perfBaseline: { mode: 'compare', baselineDir } }
  })

  const result = cmp.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {},
    metrics: { LCP: 1300, TTFB: 100 }  // LCP up 30% — regression
  })

  assert(result.regressions.length > 0, 'Expected at least one regression')
  assertEqual(result.regressions[0].metric, 'LCP')
})

test('compare mode: improvement detected when metric drops significantly', () => {
  const { handlers: rec, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'record' } } })

  rec.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { LCP: 2000 }
  })

  const { handlers: cmp } = registerTasks({ env: { perfBaseline: { mode: 'compare', baselineDir } } })

  const result = cmp.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {},
    metrics: { LCP: 1000 }  // -50% — well past half-threshold
  })

  const lcpDiff = result.diff && result.diff.find(d => d.metric === 'LCP')
  assert(lcpDiff, 'Expected LCP in diff')
  assertEqual(lcpDiff.status, 'improvement')
})

test('compare mode: cachedRequests regression when it drops below threshold', () => {
  const { handlers: rec, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'record' } } })

  rec.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { cachedRequests: 20 }
  })

  const { handlers: cmp } = registerTasks({ env: { perfBaseline: { mode: 'compare', baselineDir } } })

  const result = cmp.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {},
    metrics: { cachedRequests: 10 }  // -50% — regression for higher-is-better
  })

  const diff = result.diff && result.diff.find(d => d.metric === 'cachedRequests')
  assert(diff, 'Expected cachedRequests in diff')
  assertEqual(diff.status, 'regression')
})

test('compare mode: zero-baseline metric is skipped (no divide-by-zero)', () => {
  const { handlers: rec, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'record' } } })

  rec.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { CLS: 0, LCP: 1000 }
  })

  const { handlers: cmp } = registerTasks({ env: { perfBaseline: { mode: 'compare', baselineDir } } })

  let threw = false
  try {
    cmp.task['perfBaseline:snapshot']({
      name: 'homepage', url: 'http://localhost/', branch: 'main',
      sampleCount: 3, recordedAt: new Date().toISOString(),
      threshold: 20, thresholds: {},
      metrics: { CLS: 0.05, LCP: 1000 }
    })
  } catch (e) { threw = true }
  assert(!threw, 'Should not throw when baseline value is zero')
})

test('compare mode: no baseline found — does not throw', () => {
  const { handlers: h } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })

  let threw = false
  try {
    h.task['perfBaseline:snapshot']({
      name: 'no-baseline-page',
      url: 'http://localhost/',
      branch: 'main',
      sampleCount: 3,
      recordedAt: new Date().toISOString(),
      threshold: 20,
      thresholds: {},
      metrics: { LCP: 900 }
    })
  } catch (e) { threw = true }
  assert(!threw, 'Should not throw when no baseline exists for this page')
})

// Tests — record mode
console.log('\n - record mode -')

test('record mode: writes baseline JSON file', () => {
  const { handlers, baselineDir } = registerTasks({
    env: { perfBaseline: { mode: 'record' } }
  })

  handlers.task['perfBaseline:snapshot']({
    name: 'homepage',
    url: 'http://localhost/',
    branch: 'main',
    sampleCount: 3,
    recordedAt: new Date().toISOString(),
    threshold: 20,
    thresholds: {},
    metrics: { LCP: 1100, TTFB: 130 }
  })

  const file = path.join(baselineDir, 'main.json')
  assert(fs.existsSync(file), 'Baseline file should be created')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert(saved.homepage, 'Should have homepage entry')
  assertEqual(saved.homepage.metrics.LCP, 1100)
})

test('record mode: branch name sanitised in filename', () => {
  const { handlers, baselineDir } = registerTasks({
    env: { perfBaseline: { mode: 'record' } }
  })

  handlers.task['perfBaseline:snapshot']({
    name: 'homepage',
    url: 'http://localhost/',
    branch: 'feat/my special branch!!',
    sampleCount: 3,
    recordedAt: new Date().toISOString(),
    threshold: 20,
    thresholds: {},
    metrics: { LCP: 900 }
  })

  // Slashes and special chars become dashes
  const files = fs.readdirSync(baselineDir)
  assert(files.length === 1, 'Should create exactly one file')
  assert(!files[0].includes('/'), 'Filename should not contain slashes')
  assert(!files[0].includes('!'), 'Filename should not contain special chars')
})

test('record mode: existing entries are preserved when adding new snapshot', () => {
  const { handlers, baselineDir } = registerTasks({
    env: { perfBaseline: { mode: 'record' } }
  })

  handlers.task['perfBaseline:snapshot']({
    name: 'page-a',
    url: 'http://localhost/a',
    branch: 'main',
    sampleCount: 3,
    recordedAt: new Date().toISOString(),
    threshold: 20,
    thresholds: {},
    metrics: { LCP: 800 }
  })

  handlers.task['perfBaseline:snapshot']({
    name: 'page-b',
    url: 'http://localhost/b',
    branch: 'main',
    sampleCount: 3,
    recordedAt: new Date().toISOString(),
    threshold: 20,
    thresholds: {},
    metrics: { LCP: 950 }
  })

  const saved = JSON.parse(fs.readFileSync(path.join(baselineDir, 'main.json'), 'utf8'))
  assert(saved['page-a'], 'page-a should still exist')
  assert(saved['page-b'], 'page-b should exist')
})

// Tests — baseline file I/O
console.log('\n - baseline I/O -')

test('malformed JSON baseline throws a descriptive error', () => {
  const { handlers, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })
  fs.writeFileSync(path.join(baselineDir, 'main.json'), '{oops not json', 'utf8')

  assertThrows(
    () => handlers.task['perfBaseline:snapshot']({
      name: 'p', url: 'http://localhost', branch: 'main',
      sampleCount: 1, recordedAt: new Date().toISOString(),
      threshold: 20, thresholds: {}, metrics: { LCP: 900 }
    }),
    /Failed to parse baseline file/
  )
})

test('array baseline JSON throws a descriptive error', () => {
  const { handlers, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })
  fs.writeFileSync(path.join(baselineDir, 'main.json'), '[]', 'utf8')

  assertThrows(
    () => handlers.task['perfBaseline:snapshot']({
      name: 'p', url: 'http://localhost', branch: 'main',
      sampleCount: 1, recordedAt: new Date().toISOString(),
      threshold: 20, thresholds: {}, metrics: { LCP: 900 }
    }),
    /must contain a JSON object/
  )
})

test('falls back to main.json when branch file absent', () => {
  const { handlers: rec, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'record' } } })

  rec.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { LCP: 1000 }
  })

  // 'feature-x.json' does not exist — should fall back to main.json
  const { handlers: cmp } = registerTasks({ env: { perfBaseline: { mode: 'compare', baselineDir } } })

  const result = cmp.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'feature/x',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {},
    metrics: { LCP: 1000 }
  })

  assert(result.diff !== null, 'Diff should be populated when falling back to main.json')
})

// Tests — after:run + report generation
console.log('\n - after:run + report -')

test('after:run: generates an HTML report file', () => {
  const { handlers, reportDir } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })

  handlers.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { LCP: 900 }
  })

  handlers['after:run']()
  assert(fs.existsSync(path.join(reportDir, 'perf-report.html')), 'perf-report.html must exist')
})

test('after:run: report contains branch name from snapshot', () => {
  const { handlers, reportDir } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })

  handlers.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'feat/pretty-branch',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { LCP: 900 }
  })

  handlers['after:run']()
  const html = fs.readFileSync(path.join(reportDir, 'perf-report.html'), 'utf8')
  assertContains(html, 'feat/pretty-branch')
})

test('after:run: sets process.exitCode=1 when failOnRegression=true and regression found', () => {
  const origCode = process.exitCode

  const { handlers: rec, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'record' } } })
  rec.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { LCP: 1000 }
  })

  const { handlers: cmp } = registerTasks({
    env: { perfBaseline: { mode: 'compare', failOnRegression: true, baselineDir } }
  })

  cmp.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {},
    metrics: { LCP: 1500 }  // +50% — regression
  })

  process.exitCode = undefined
  cmp['after:run']()
  const exitCode = process.exitCode
  process.exitCode = origCode

  assertEqual(exitCode, 1, 'process.exitCode should be 1 on regression')
})

test('after:run: does NOT set exitCode=1 when failOnRegression=false', () => {
  const origCode = process.exitCode

  const { handlers: rec, baselineDir } = registerTasks({ env: { perfBaseline: { mode: 'record' } } })
  rec.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { LCP: 1000 }
  })

  const { handlers: cmp } = registerTasks({
    env: { perfBaseline: { mode: 'compare', failOnRegression: false, baselineDir } }
  })

  cmp.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {},
    metrics: { LCP: 1500 }
  })

  process.exitCode = undefined
  cmp['after:run']()
  const exitCode = process.exitCode
  process.exitCode = origCode

  assert(exitCode !== 1, 'process.exitCode should NOT be 1 when failOnRegression=false')
})

test('after:run: no crash when zero snapshots', () => {
  const { handlers } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })
  let threw = false
  try { handlers['after:run']() } catch (e) { threw = true }
  assert(!threw, 'Should not throw when after:run fires with no snapshots')
})

// Tests — perfBaseline:getLastSnapshot
console.log('\n - getLastSnapshot -')

test('getLastSnapshot returns null when no snapshot recorded', () => {
  const { handlers } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })
  const result = handlers.task['perfBaseline:getLastSnapshot']({ name: 'does-not-exist' })
  assertEqual(result, null)
})

test('getLastSnapshot returns the last recorded snapshot for the name', () => {
  const { handlers } = registerTasks({ env: { perfBaseline: { mode: 'compare' } } })

  handlers.task['perfBaseline:snapshot']({
    name: 'homepage', url: 'http://localhost/', branch: 'main',
    sampleCount: 3, recordedAt: new Date().toISOString(),
    threshold: 20, thresholds: {}, metrics: { LCP: 999 }
  })

  const snap = handlers.task['perfBaseline:getLastSnapshot']({ name: 'homepage' })
  assert(snap !== null, 'Should find snapshot')
  assertEqual(snap.metrics.LCP, 999)
})

// Tests — generateReport
console.log('\n - generateReport -')

test('generateReport: produces a valid HTML file', () => {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cpb-report-'))
  const reportPath = path.join(tmpDir, 'test-report.html')

  generateReport({
    snapshots:   [makeSnap()],
    config:      resolveConfig({}),
    runDuration: 3000,
    branch:      'main',
    reportPath,
  })

  const html = fs.readFileSync(reportPath, 'utf8')
  assertContains(html, '<!DOCTYPE html>')
  assertContains(html, 'Cypress Perf Report')
  assertContains(html, 'homepage')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('generateReport: per-metric percent delta uses correct sign', () => {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cpb-report-'))
  const reportPath = path.join(tmpDir, 'delta-report.html')

  generateReport({
    snapshots: [makeSnap({
      diff: [
        { metric: 'LCP',          current: 900,  baseline: 1100, pctChange: -18, threshold: 15, status: 'improvement' },
        { metric: 'jsTransferKb', current: 750,  baseline: 600,  pctChange: +25, threshold: 10, status: 'regression'  },
        { metric: 'TTFB',         current: 100,  baseline: 100,  pctChange: 0,   threshold: 20, status: 'ok'          },
      ],
      regressions: [
        { metric: 'jsTransferKb', current: 750, baseline: 600, pctChange: +25, threshold: 10, status: 'regression' }
      ],
      hasRegression: true
    })],
    config:      resolveConfig({}),
    runDuration: 3000,
    branch:      'main',
    reportPath,
  })

  const html = fs.readFileSync(reportPath, 'utf8')
  assertContains(html, '-18%')
  assertContains(html, '+25%')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('generateReport: best improvement shows highest abs improvement', () => {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cpb-report-'))
  const reportPath = path.join(tmpDir, 'best-report.html')

  const a = makeSnap({ name: 'page-a', diff: [{ metric: 'LCP', current: 900, baseline: 1100, pctChange: -18, threshold: 15, status: 'improvement', page: 'page-a' }] })
  const b = makeSnap({ name: 'page-b', diff: [{ metric: 'FCP', current: 300, baseline: 800,  pctChange: -63, threshold: 15, status: 'improvement', page: 'page-b' }] })

  generateReport({
    snapshots:   [a, b],
    config:      resolveConfig({}),
    runDuration: 3000,
    branch:      'main',
    reportPath,
  })

  const html = fs.readFileSync(reportPath, 'utf8')
  // FCP -63% is a bigger improvement magnitude than LCP -18%
  assertContains(html, '63% better')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('generateReport: Chart.js guard prevents runtime crash when CDN unavailable', () => {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cpb-report-'))
  const reportPath = path.join(tmpDir, 'guard-report.html')

  generateReport({
    snapshots:   [makeSnap()],
    config:      resolveConfig({}),
    runDuration: 3000,
    branch:      'main',
    reportPath,
  })

  const html = fs.readFileSync(reportPath, 'utf8')
  assertContains(html, "typeof Chart === 'function'")

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

test('generateReport: XSS in page names is escaped', () => {
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'cpb-report-'))
  const reportPath = path.join(tmpDir, 'xss-report.html')

  generateReport({
    snapshots: [makeSnap({
      name: '<script>alert(1)</script>',
      url:  'https://evil.example/?x=<script>alert(1)</script>',
    })],
    config:      resolveConfig({}),
    runDuration: 3000,
    branch:      'main',
    reportPath,
  })

  const html = fs.readFileSync(reportPath, 'utf8')
  assert(!html.includes('<script>alert(1)</script>'), 'Raw XSS payload must not appear in HTML')
  // Must be HTML-escaped or unicode-escaped in chart data
  assert(
    html.includes('&lt;script&gt;') || html.includes('\\u003cscript\\u003e'),
    'Script tags should be entity-escaped in page name'
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// Tests — collector precision
console.log('\n - collector precision -')

test('collector: includes sub-ms rounding helper for paint metrics', () => {
  assertContains(collectorSrc, 'function roundSubMs(value)')
  assertContains(collectorSrc, 'Math.round(value * 10) / 10')
})

test('collector: LCP/FCP are not integer-rounded to zero', () => {
  assert(!collectorSrc.includes('lcpValue = Math.round('), 'LCP should not use integer Math.round')
  assert(!collectorSrc.includes('fcpValue = Math.round('), 'FCP should not use integer Math.round')
  assertContains(collectorSrc, 'lcpValue = roundSubMs(')
  assertContains(collectorSrc, 'fcpValue = roundSubMs(')
})

// Summary
console.log('')
console.log(` - ${passed} passed, ${failed} failed`)
console.log('')

if (failed > 0) process.exit(1)

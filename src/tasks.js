// src/tasks.js
// Node.js side of the plugin — runs in the Cypress backend process, not the browser.
// Handles: baseline file I/O, diff computation, run accumulation, report generation.
//
// Register in cypress.config.js:
//   const { perfTasks } = require('cypress-perf-baseline')
//   setupNodeEvents(on, config) { perfTasks(on, config); return config }

const fs   = require('fs')
const path = require('path')

const { resolveConfig }  = require('./config')
const { generateReport } = require('./report-generator')

// Snapshots collected during the current run — reset at run start
let runSnapshots = []
let runStartTime = Date.now()

// perfTasks(on, config)
// The single function you register in setupNodeEvents.
function perfTasks(on, config) {
  const cfg = resolveConfig(config.env)
  const runBranch = (config.env && config.env.BRANCH_NAME) || process.env.BRANCH_NAME || 'main'

  // Reset state at the start of each run
  runSnapshots = []
  runStartTime = Date.now()

  // Make sure output directories exist
  ensureDir(cfg.baselineDir)
  ensureDir(cfg.reportDir)

  // tasks
  // IMPORTANT: Cypress only supports ONE on('task', {...}) registration per
  // plugin. A second call silently overwrites the first — all tasks MUST be
  // in a single object. Both perfBaseline:snapshot and perfBaseline:getLastSnapshot
  // are registered here together.
  on('task', {

    // perfBaseline:snapshot
    // Called by cy.perfSnapshot() after browser-side collection.
    // Reads baseline, diffs, logs results, stores snapshot for the report.
    'perfBaseline:snapshot'(snapshotData) {
      const { name, metrics, threshold, thresholds } = snapshotData
      const branch = snapshotData.branch || runBranch
      const mode = cfg.mode

      const baseline      = loadBaseline(cfg.baselineDir, branch)
      const baselineEntry = baseline[name] || null

      let diff         = null
      let regressions  = []
      let improvements = []

      if (mode === 'compare' && baselineEntry) {
        diff         = computeDiff(metrics, baselineEntry.metrics, thresholds, threshold)
        regressions  = diff.filter(d => d.status === 'regression')
        improvements = diff.filter(d => d.status === 'improvement')

        console.log(`\n - [perf] "${name}"`)
        console.log('  ' + '─'.repeat(60))
        diff.forEach(d => {
          const arrow  = formatTrendLabel(d.status, d.pctChange)
          const pctStr = ` (${formatPercentChange(d.pctChange)})`
          const flag   = d.status === 'regression' ? '  ⚠' : ''
          console.log(
            `    ${d.metric.padEnd(20)}` +
            `${String(d.current).padStart(8)}  ` +
            `was ${String(d.baseline).padStart(8)}` +
            `${pctStr.padEnd(10)} ${arrow}${flag}`
          )
        })

        if (regressions.length) {
          console.log(`\n  -  ${regressions.length} regression(s) in "${name}":`)
          regressions.forEach(r => {
            console.log(
              `     ${r.metric}: ${r.current} vs baseline ${r.baseline}` +
              ` (${formatPercentChange(r.pctChange)}) — threshold ${r.threshold}%`
            )
          })
        } else {
          console.log(`\n  -  "${name}" — all metrics within thresholds`)
        }

      } else if (mode === 'record') {
        console.log(`\n  -  "${name}" — recording baseline (${snapshotData.sampleCount} samples, median)`)
        console.log('  ' + '─'.repeat(50))
        Object.entries(metrics).forEach(([k, v]) => {
          if (typeof v === 'number') console.log(`    ${k.padEnd(20)} ${v}`)
        })

      } else if (mode === 'compare' && !baselineEntry) {
        console.log(`\n  -  "${name}" — no baseline found`)
        console.log('         Run with PERF_MODE=record to save a baseline.')
      }

      if (mode === 'record') {
        baseline[name] = {
          metrics,
          recordedAt:  snapshotData.recordedAt,
          branch,
          sampleCount: snapshotData.sampleCount,
          url:         snapshotData.url,
        }
        saveBaseline(cfg.baselineDir, branch, baseline)
        console.log(`  -  Baseline saved → ${baselineFilePath(cfg.baselineDir, branch)}`)
      }

      runSnapshots.push({
        ...snapshotData,
        baselineMetrics: baselineEntry ? baselineEntry.metrics : null,
        diff,
        regressions,
        improvements,
        hasRegression: regressions.length > 0,
      })

      return { name, mode, diff, regressions, improvements, metrics }
    },

    // perfBaseline:getLastSnapshot
    // Used by cy.perfAssert() to retrieve the last snapshot for a given name.
    'perfBaseline:getLastSnapshot'({ name }) {
      const snap = [...runSnapshots].reverse().find(s => s.name === name)
      return snap || null
    },

  })

  // after:run
  // Fires after the entire Cypress run finishes.
  // Generates the HTML report and optionally fails the build.
  on('after:run', () => {
    const totalRegressions = runSnapshots.filter(s => s.hasRegression).length
    const totalSnapshots   = runSnapshots.length

    if (totalSnapshots === 0) {
      console.log('\n - [cypress-perf-baseline] No snapshots recorded in this run.')
      return
    }

    const durationSec = ((Date.now() - runStartTime) / 1000).toFixed(1)
    console.log(`\n - [cypress-perf-baseline] Run complete (${durationSec}s)`)
    console.log(`- Snapshots: ${totalSnapshots}  |  Regressions: ${totalRegressions}`)

    // Generate self-contained HTML report
    const reportPath = path.join(cfg.reportDir, 'perf-report.html')
    try {
      generateReport({
        snapshots:   runSnapshots,
        config:      cfg,
        runDuration: Date.now() - runStartTime,
        branch:      runSnapshots[0] && runSnapshots[0].branch ? runSnapshots[0].branch : runBranch,
        reportPath,
      })
      console.log(`- Report → ${reportPath}`)
      console.log('- Open the report in a browser to view detailed results')
    } catch (err) {
      console.error(`! Report generation failed: ${err.message}`)
    }

    // Fail the build if regressions were found and failOnRegression is true
    if (totalRegressions > 0 && cfg.failOnRegression) {
      console.log(
        `\n - ${totalRegressions} page(s) have performance regressions — exiting with code 1.` +
        `\n     Set failOnRegression: false in config to warn without failing.\n`
      )
      process.exitCode = 1

    } else if (totalRegressions > 0) {
      console.log(
        `\n - ${totalRegressions} regression(s) found — failOnRegression is false, continuing.\n`
      )
    } else {
      console.log('- All metrics within thresholds — no regressions.\n')
    }

    // Reset for the next run
    runSnapshots = []
    runStartTime = Date.now()
  })
}

// Baseline file helpers
function baselineFilePath(dir, branch) {
  const safe = (branch || 'main')
    .replace(/[^a-zA-Z0-9\-_]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
  return path.join(dir, `${safe}.json`)
}

function loadBaseline(dir, branch) {
  // Try branch-specific file first, fall back to main
  const branchFile = baselineFilePath(dir, branch)
  const mainFile   = baselineFilePath(dir, 'main')
  const files      = branchFile === mainFile ? [branchFile] : [branchFile, mainFile]

  for (const file of files) {
    if (fs.existsSync(file)) {
      let parsed
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (err) {
        throw new Error(
          `! [cypress-perf-baseline] Failed to parse baseline file "${file}": ${err.message}`
        )
      }
      validateBaselineShape(parsed, file)
      return parsed
    }
  }
  return {}
}

function saveBaseline(dir, branch, data) {
  fs.writeFileSync(
    baselineFilePath(dir, branch),
    JSON.stringify(data, null, 2),
    'utf8'
  )
}

// Diff computation
// Compares current metric values against baseline values.
// Returns an array of diff objects sorted: regressions first.
// Metrics where a higher value is actually better (only cachedRequests)
const HIGHER_IS_BETTER = new Set(['cachedRequests'])

// Non-comparable fields — skip in diff
const SKIP_DIFF = new Set([
  'collectedAt', 'url', 'serverTiming', 'slowestResourceName',
])

function computeDiff(current, baseline, thresholds, globalThreshold) {
  const diffs = []
  const allKeys = new Set([
    ...Object.keys(current),
    ...Object.keys(baseline || {}),
  ])

  allKeys.forEach(metric => {
    if (SKIP_DIFF.has(metric)) return

    const curr = current[metric]
    const base = (baseline || {})[metric]

    if (typeof curr !== 'number' || typeof base !== 'number') return
    if (base === 0) return  // Avoid divide-by-zero on zero-baseline metrics

    const threshold    = thresholds[metric] !== undefined ? thresholds[metric] : globalThreshold
    const pctChange    = Math.round(((curr - base) / base) * 100)
    const higherBetter = HIGHER_IS_BETTER.has(metric)

    const isRegression  = higherBetter ? pctChange < -threshold  : pctChange > threshold
    const isImprovement = higherBetter
      ? pctChange > Math.floor(threshold / 2)
      : pctChange < -Math.floor(threshold / 2)

    diffs.push({
      metric,
      current:   curr,
      baseline:  base,
      pctChange,
      threshold,
      status: isRegression  ? 'regression'  :
              isImprovement ? 'improvement' : 'ok',
    })
  })

  // Sort: regressions → improvements → ok
  const order = { regression: 0, improvement: 1, ok: 2 }
  return diffs.sort((a, b) => order[a.status] - order[b.status])
}

// Utility
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true })
  }
}

function formatPercentChange(pctChange) {
  return `${pctChange > 0 ? '+' : ''}${pctChange}%`
}

function formatTrendLabel(status, pctChange) {
  if (status === 'ok') return '→ ok'
  const arrow = pctChange > 0 ? '↑' : '↓'
  return `${arrow} ${status === 'regression' ? 'REGRESSION' : 'improved'}`
}

function validateBaselineShape(baseline, file) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new Error(
      `! [cypress-perf-baseline] Baseline file "${file}" must contain a JSON object keyed by snapshot name`
    )
  }
}

module.exports = perfTasks

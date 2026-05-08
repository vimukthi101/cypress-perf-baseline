#!/usr/bin/env node
// scripts/run-integration.js
// Runs Cypress integration spec in record/compare mode with a local example server.

const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const mode = (process.argv[2] || 'compare').toLowerCase()
if (!['record', 'compare'].includes(mode)) {
  console.error('! [integration] Mode must be "record" or "compare"')
  process.exit(1)
}

const ROOT_DIR = path.resolve(__dirname, '..')
const SERVER_URL = 'http://127.0.0.1:3333/'
const BROWSER = process.env.CYPRESS_PERF_BROWSER || 'chrome'

function waitForServer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs

    function check() {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
          resolve()
        } else if (Date.now() > deadline) {
          reject(new Error(`! Server did not become ready (${res.statusCode || 'no status'})`))
        } else {
          setTimeout(check, 300)
        }
      })

      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('! Server did not become ready before timeout'))
        } else {
          setTimeout(check, 300)
        }
      })
    }

    check()
  })
}

function spawnPromise(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`! Command failed (${command} ${args.join(' ')}) with exit code ${code}`))
    })
  })
}

async function run() {
  const httpServerBin = require.resolve('http-server/bin/http-server')
  const cypressBin = path.join(ROOT_DIR, 'node_modules', 'cypress', 'bin', 'cypress')

  let server = null

  const serverAlreadyRunning = await waitForServer(SERVER_URL, 500)
    .then(() => true)
    .catch(() => false)

  if (!serverAlreadyRunning) {
    server = spawn(
      process.execPath,
      [httpServerBin, 'example', '-p', '3333', '--silent'],
      { cwd: ROOT_DIR, stdio: 'inherit' }
    )

    // Prevent unhandled child-process errors when startup races with an external server.
    server.on('error', (err) => {
      console.error(`! [integration] server process error: ${err.message}`)
    })

    await waitForServer(SERVER_URL, 15000)
  }

  let stopping = false
  function stopServer() {
    if (!server) return
    if (stopping) return
    stopping = true
    if (server.exitCode === null && !server.killed) server.kill()
  }

  process.on('SIGINT', () => {
    stopServer()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    stopServer()
    process.exit(143)
  })

  try {
    if (mode === 'record') process.env.PERF_MODE = 'record'
    else delete process.env.PERF_MODE

    console.log(`- [integration] Running Cypress in ${mode} mode with browser: ${BROWSER}`)

    await spawnPromise(
      process.execPath,
      [cypressBin, 'run', '--browser', BROWSER, '--headless', '--spec', 'cypress/e2e/perf.cy.js'],
      { cwd: ROOT_DIR, stdio: 'inherit' }
    )
  } finally {
    stopServer()
  }
}

run().catch((err) => {
  console.error(`! [integration] ${err.message}`)
  process.exit(1)
})

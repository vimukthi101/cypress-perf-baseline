// cypress-perf-baseline — main entry point
//
// Setup in cypress.config.js:
//   const { perfTasks } = require('cypress-perf-baseline')
//   setupNodeEvents(on, config) { perfTasks(on, config); return config }
//
// Setup in cypress/support/e2e.js:
//   require('cypress-perf-baseline/src/commands')

const perfTasks = require('./tasks')

module.exports = { perfTasks }

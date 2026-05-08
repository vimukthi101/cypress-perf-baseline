// cypress.config.js
// Cypress config used by this repo's integration tests.
// Consumers should follow the setup snippet in README.md.

const { defineConfig } = require('cypress')
const { perfTasks }    = require('./src')

module.exports = defineConfig({
  e2e: {
    // Integration tests run against the local example page.
    // Start the server first: npm run serve:example
    baseUrl: 'http://localhost:3333',

    specPattern:              'cypress/e2e/*.cy.js',
    supportFile:              'cypress/support/e2e.js',

    // Keep CI output small
    video:                    false,
    screenshotOnRunFailure:   false,

    setupNodeEvents(on, config) {
      perfTasks(on, config)
      return config
    },

    env: {
      perfBaseline: {
        // Keep integration artifacts separate from demo baseline files
        baselineDir:     'cypress/integration-baselines',
        reportDir:       'cypress/integration-reports',

        // Multiple samples reduce LCP/FCP variance between record and compare runs.
        samples:          3,
        // Localhost metrics are often single-digit ms; keep compare run stable.
        threshold:        500,
        settleTime:       300,
        networkIdleTime:  200,

        // Fail when compare run regresses from the baseline recorded in CI
        failOnRegression: true,
      }
    }
  }
})

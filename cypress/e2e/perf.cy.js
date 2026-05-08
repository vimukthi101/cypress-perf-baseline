// cypress/e2e/perf.cy.js
// Integration tests for this plugin.
//
// These tests run against example/index.html served locally.
// They verify real plugin usage end-to-end.
//
// To run locally:
//   npm run test:integration:record
//   npm run test:integration:compare

describe('cypress-perf-baseline plugin', () => {
  // Confirm the example page is fully ready before snapshotting.
  // Keep this first for fast-fail diagnostics when setup breaks.
  it('example page loads all content before snapshot', () => {
    cy.visit('/')
    cy.get('[data-cy="heading"]').should('have.text', 'cypress-perf-baseline')
    cy.get('[data-cy="feature-list"] li').should('have.length', 4)
    cy.get('[data-cy="status"]').should('contain', 'Integration test target')
    cy.perfSnapshot('example-page-full-load')
  })

  // Basic snapshot path
  it('records a snapshot and returns metric data', () => {
    cy.visit('/')
    cy.get('[data-cy="heading"]').should('be.visible')
    cy.perfSnapshot('example-page').then(result => {
      // In record mode diff is null; in compare mode diff is an array
      expect(result).to.have.property('name', 'example-page')
      expect(result).to.have.property('metrics')
      expect(result.metrics).to.have.property('LCP')
      expect(result.metrics).to.have.property('TTFB')
      expect(result.metrics).to.have.property('requests')
    })
  })

  // Hard budget assertion path
  it('passes cy.perfAssert() budgets for the example page', () => {
    cy.visit('/')
    cy.get('[data-cy="heading"]').should('be.visible')
    cy.perfSnapshot('example-page-budget')
    cy.perfAssert('example-page-budget', {
      // Keep budgets loose to avoid environment-specific flakiness
      requests:        { max: 20 },
      totalTransferKb: { max: 500 },
      longTaskCount:   { max: 10 },
    })
  })
})

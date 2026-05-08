// src/collector.js
// Runs INSIDE the browser via cy.window().then(win => new win.Function(...))
// Collects all performance metrics using the standard browser Performance API.
// Returns a plain serialisable object — no DOM references, no functions.
//
// This file exports the function SOURCE as a string so tasks.js can inject it
// into the browser context via Cypress's cy.window() command.

function collectMetrics() {
  return new Promise(function(resolve) {
    var result = {}
    var observers = []

    // Navigation Timing
    // All timings relative to navigationStart so numbers are comparable across different pages and runs.
    var navEntries = performance.getEntriesByType('navigation')
    var nav = navEntries[0] || null

    if (nav) {
      result.TTFB           = Math.round(nav.responseStart  - nav.startTime)
      result.domInteractive = Math.round(nav.domInteractive - nav.startTime)
      result.domComplete    = Math.round(nav.domComplete    - nav.startTime)
      result.loadEvent      = Math.round(nav.loadEventEnd   - nav.startTime)

      // DNS / TCP / TLS — meaningful on cold loads, zero on cached connections
      var dns = nav.domainLookupEnd - nav.domainLookupStart
      var tcp = nav.connectEnd      - nav.connectStart
      var tls = nav.secureConnectionStart > 0
        ? nav.requestStart - nav.secureConnectionStart
        : 0

      result.dnsLookup    = Math.round(Math.max(0, dns))
      result.tcpConnect   = Math.round(Math.max(0, tcp))
      result.tlsHandshake = Math.round(Math.max(0, tls))

      // Server-Timing headers (if backend exposes them)
      var serverTimings = {}
      if (nav.serverTiming && nav.serverTiming.length) {
        nav.serverTiming.forEach(function(st) {
          serverTimings[st.name] = Math.round(st.duration)
        })
      }
      result.serverTiming = serverTimings
    }

    // Resource Timing
    // Aggregate all resources loaded by the page. Filter out Cypress's own internal requests — these are injected by the
    // test runner and would inflate request counts and pollute the slowest resource name with Cypress framework internals.
    var CYPRESS_PATTERNS = ['/__cypress/', '/__socket', '/cypress-', '__cypress']
    var resources = performance.getEntriesByType('resource').filter(function(r) {
      return !CYPRESS_PATTERNS.some(function(p) { return r.name.indexOf(p) !== -1 })
    })
    var jsKb = 0, cssKb = 0, imgKb = 0, totalKb = 0
    var reqCount = 0, cachedCount = 0
    var slowestMs = 0, slowestName = ''

    // Include the main document transfer from Navigation Timing.
    // Resource Timing does not include the HTML document itself.
    if (nav) {
      var docKb = (nav.encodedBodySize || nav.transferSize || 0) / 1024
      totalKb += docKb
      reqCount++
      if (nav.transferSize === 0 && nav.decodedBodySize > 0) cachedCount++
    }

    resources.forEach(function(r) {
      // encodedBodySize = compressed bytes over the wire
      // transferSize === 0 with decodedBodySize > 0 means served from cache
      var kb = (r.encodedBodySize || r.transferSize || 0) / 1024
      totalKb += kb
      reqCount++

      if (r.transferSize === 0 && r.decodedBodySize > 0) cachedCount++

      var type = r.initiatorType
      if (type === 'script')                     jsKb  += kb
      else if (type === 'link' || type === 'css') cssKb += kb
      else if (type === 'img' || type === 'image') imgKb += kb

      if (r.duration > slowestMs) {
        slowestMs   = r.duration
        // Strip query strings from resource name for cleaner display
        slowestName = r.name.split('/').pop().split('?')[0]
      }
    })

    result.jsTransferKb       = Math.round(jsKb)
    result.cssTransferKb      = Math.round(cssKb)
    result.imgTransferKb      = Math.round(imgKb)
    result.totalTransferKb    = Math.round(totalKb)
    result.requests           = reqCount
    result.cachedRequests     = cachedCount
    result.slowestResourceMs  = Math.round(slowestMs)
    result.slowestResourceName = slowestName

    // Core Web Vitals + Long Tasks via PerformanceObserver
    // Use buffered:true to catch entries that fired before this code ran.
    // This handles the case where cy.perfSnapshot() is called after page load.
    var lcpValue = 0
    var fcpValue = 0
    var clsValue = 0
    var longTaskCount = 0
    var longTaskMs    = 0

    function roundSubMs(value) {
      if (!isFinite(value) || value <= 0) return 0
      var rounded = Math.round(value * 10) / 10
      return rounded > 0 ? rounded : 0.1
    }

    var supported = []
    try { supported = PerformanceObserver.supportedEntryTypes || [] } catch(e) {}

    // LCP — Largest Contentful Paint
    if (supported.indexOf('largest-contentful-paint') !== -1) {
      try {
        var lcpObs = new PerformanceObserver(function(list) {
          var entries = list.getEntries()
          if (entries.length) {
            lcpValue = roundSubMs(entries[entries.length - 1].startTime)
          }
        })
        lcpObs.observe({ type: 'largest-contentful-paint', buffered: true })
        observers.push(lcpObs)
      } catch(e) {}
    }

    // FCP — First Contentful Paint
    if (supported.indexOf('paint') !== -1) {
      try {
        var fcpObs = new PerformanceObserver(function(list) {
          list.getEntries().forEach(function(e) {
            if (e.name === 'first-contentful-paint') fcpValue = roundSubMs(e.startTime)
          })
        })
        fcpObs.observe({ type: 'paint', buffered: true })
        observers.push(fcpObs)
      } catch(e) {}
    }

    // CLS — Cumulative Layout Shift (excludes shifts after user input)
    if (supported.indexOf('layout-shift') !== -1) {
      try {
        var clsObs = new PerformanceObserver(function(list) {
          list.getEntries().forEach(function(e) {
            if (!e.hadRecentInput) clsValue += e.value
          })
        })
        clsObs.observe({ type: 'layout-shift', buffered: true })
        observers.push(clsObs)
      } catch(e) {}
    }

    // Long Tasks — main thread blocked >50ms
    if (supported.indexOf('longtask') !== -1) {
      try {
        var ltObs = new PerformanceObserver(function(list) {
          list.getEntries().forEach(function(e) {
            longTaskCount++
            longTaskMs += e.duration
          })
        })
        ltObs.observe({ type: 'longtask', buffered: true })
        observers.push(ltObs)
      } catch(e) {}
    }

    // Wait 800ms for buffered observer entries to flush, then collect results.
    // This is enough time for LCP/CLS observers to receive all buffered entries.
    setTimeout(function() {
      observers.forEach(function(o) { try { o.disconnect() } catch(e) {} })

      result.LCP           = lcpValue
      result.FCP           = fcpValue
      result.CLS           = Math.round(clsValue * 1000) / 1000  // 3 decimal places
      result.longTaskCount = longTaskCount
      result.longTaskMs    = Math.round(longTaskMs)
      result.collectedAt   = Date.now()
      result.url           = location.href

      resolve(result)
    }, 800)
  })
}

// Export the function source as a string.
// commands.js injects it into the browser via: new win.Function(`return (${src})()`)
module.exports = collectMetrics.toString()

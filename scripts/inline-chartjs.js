#!/usr/bin/env node
// scripts/inline-chartjs.js
//
// Downloads Chart.js minified source and inlines it into report-generator.js
// so generated HTML reports are fully self-contained with no external requests.
//
// This is useful for environments that block external CDN requests or for
// offline report viewing and archival.
//
// Usage:
//   node scripts/inline-chartjs.js
//   npm run inline-chartjs

const https = require('https')
const fs    = require('fs')
const path  = require('path')

const CHARTJS_URL  = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js'
const GENERATOR    = path.join(__dirname, '../src/report-generator.js')
// Match the CDN tag whether it already has SRI/crossorigin attributes
const PLACEHOLDER_RE = /const CHARTJS_TAG = `<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/Chart\.js\/4\.4\.1\/chart\.umd\.min\.js"[^`]*><\\\/script>`/

console.log('- Downloading Chart.js 4.4.1...')

https.get(CHARTJS_URL, (res) => {
  if (res.statusCode !== 200) {
    console.error(`! HTTP ${res.statusCode} — download failed`)
    process.exit(1)
  }

  const chunks = []
  res.on('data', chunk => chunks.push(chunk))
  res.on('end', () => {
    const src = Buffer.concat(chunks).toString('utf8')
    const kb  = (src.length / 1024).toFixed(1)

    // Escape backticks and template literal syntax so we can embed in a JS string
    const escaped = src.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
    // Also escape </script> sequences in the source so they don't close the outer tag early
    const safeEscaped = escaped.replace(/<\/script>/gi, '<\\/script>')

    let generator = fs.readFileSync(GENERATOR, 'utf8')

    if (PLACEHOLDER_RE.test(generator)) {
      // Replace the CDN <script> tag (with or without existing SRI attributes) with the inlined version
      generator = generator.replace(
        PLACEHOLDER_RE,
        `const CHARTJS_TAG = \`<script>${safeEscaped}<\\/script>\``
      )
    } else {
      // Already inlined as a raw <script> block — replace the whole constant
      generator = generator.replace(
        /const CHARTJS_TAG = `[\s\S]*?`/,
        `const CHARTJS_TAG = \`<script>${safeEscaped}<\\/script>\``
      )
    }

    fs.writeFileSync(GENERATOR, generator, 'utf8')

    console.log(`- Chart.js (${kb}kb) inlined into src/report-generator.js`)
    console.log('- Generated HTML reports are now fully self-contained.')
    console.log('- Reports can be viewed offline or archived without CDN dependencies.\n')
  })
}).on('error', err => {
  console.error('! Download failed:', err.message)
  process.exit(1)
})

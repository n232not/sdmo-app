// Entry point: install the electron mock first, then load + run all *.test.js files.
require('./_electronMock')

const fs = require('fs')
const path = require('path')

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort()

console.log(`Loading ${files.length} test file(s): ${files.join(', ')}\n`)
for (const f of files) require(path.join(__dirname, f))

require('./_harness').run()

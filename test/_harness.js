// Tiny zero-dependency test runner. test(name, fn) registers; run() executes all,
// prints a summary, and exits non-zero on any failure.
const tests = []

function test(name, fn) {
  tests.push({ name, fn })
}

async function run() {
  let passed = 0, failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
      console.log(`  ✓ ${t.name}`)
    } catch (e) {
      failed++
      console.log(`  ✗ ${t.name}`)
      console.log('      ' + String((e && e.stack) || e).split('\n').join('\n      '))
    }
  }
  console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`)
  // Hard-exit so the 2s debounce timers scheduled by IPC handlers don't keep us alive.
  process.exit(failed ? 1 : 0)
}

module.exports = { test, run }

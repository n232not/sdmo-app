const assert = require('assert')
const { test } = require('./_harness')
const { validateIpcArgs } = require('../electron/ipc/contracts')

test('ipc contracts: accepts valid id-like renderer arguments', () => {
  assert.doesNotThrow(() => validateIpcArgs('encounters:rename', ['1', 2, 'New Name']))
  assert.doesNotThrow(() => validateIpcArgs('media:bulkUpdateType', [1, ['2', 3], null]))
  assert.doesNotThrow(() => validateIpcArgs('setup:saveForm', [1, { name: 'Form', schema: { sections: [] } }]))
})

test('ipc contracts: rejects malformed arguments before handlers run', () => {
  assert.throws(
    () => validateIpcArgs('encounters:delete', ['not-an-id', 2]),
    /Invalid IPC arguments/
  )
  assert.throws(
    () => validateIpcArgs('media:bulkDelete', [1, ['2', 'bad']]),
    /Invalid IPC arguments/
  )
  assert.throws(
    () => validateIpcArgs('setup:saveInstruction', [1, null]),
    /Invalid IPC arguments/
  )
})

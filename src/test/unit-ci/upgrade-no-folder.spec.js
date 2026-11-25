/**
 * The in-app upgrade must launch the installer without also revealing the
 * temp folder in File Explorer. Both modules pull in electron, so the
 * behaviour is pinned on their source instead of imported at runtime.
 */
const { describe, test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..', '..')
const downloader = fs.readFileSync(
  path.join(ROOT, 'src/app/server/download-upgrade.js'),
  'utf8'
)
const ipc = fs.readFileSync(
  path.join(ROOT, 'src/app/lib/ipc.js'),
  'utf8'
)

describe('in-app upgrade installer launch', () => {
  test('the downloader still launches the downloaded installer', () => {
    assert.match(downloader, /openFile\(this\.localPath\)/)
  })

  test('the downloader no longer asks to show the file in a folder', () => {
    assert.ok(
      !downloader.includes('showFileInFolder'),
      'no showFileInFolder message may be sent'
    )
  })

  test('the main process no longer handles a showFileInFolder message', () => {
    assert.ok(
      !ipc.includes('showFileInFolder'),
      'no stale listener for the removed message'
    )
  })

  test('the main process no longer imports shell just for that listener', () => {
    assert.ok(!ipc.includes('shell.showItemInFolder'))
  })
})

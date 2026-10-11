import { expect, test } from 'bun:test'
import { UpdateController, type UpdateHandle } from '../src/lib/update-controller'

function fixture(overrides: Partial<UpdateHandle> = {}) {
  const calls = { check: 0, download: 0, install: 0, close: 0, relaunch: 0 }
  const handle: UpdateHandle = {
    version: '0.2.0',
    async download() { calls.download++ },
    async install() { calls.install++ },
    async close() { calls.close++ },
    ...overrides,
  }
  const adapter = {
    async check(): Promise<UpdateHandle | null> { calls.check++; return handle },
    async relaunch() { calls.relaunch++ },
  }
  const controller = new UpdateController(adapter)
  controller.enable()
  return { controller, calls, handle, adapter }
}

test('downloads automatically but only installs and restarts on request', async () => {
  const { controller, calls } = fixture()
  await controller.check()
  expect(controller.getSnapshot().phase).toBe('ready')
  expect(calls).toEqual({ check: 1, download: 1, install: 0, close: 0, relaunch: 0 })
  await controller.restart()
  expect(calls.install).toBe(1)
  expect(calls.relaunch).toBe(1)
  expect(calls.close).toBe(1)
})

test('overlapping checks and checks with a staged update cannot replace it', async () => {
  const { controller, calls } = fixture()
  await Promise.all([controller.check(), controller.check(), controller.check(true)])
  await controller.check()
  expect(calls.check).toBe(1)
  expect(calls.download).toBe(1)
})

test('network Finished does not accept a failed signature', async () => {
  const { controller, calls } = fixture({
    async download(onEvent) {
      onEvent({ event: 'Started', data: { contentLength: 10 } })
      onEvent({ event: 'Progress', data: { chunkLength: 10 } })
      onEvent({ event: 'Finished' })
      expect(controller.getSnapshot().phase).toBe('downloading')
      throw new Error('Invalid signature')
    },
  })
  await controller.check()
  await controller.restart()
  expect(controller.getSnapshot().phase).toBe('error')
  expect(calls.close).toBe(1)
  expect(calls.install).toBe(0)
})

test('missing releases and network failures are not falsely reported as up to date; manual retry works', async () => {
  const { controller, adapter } = fixture()
  adapter.check = async () => { throw new Error('Could not fetch a valid release JSON') }
  await controller.check()
  expect(controller.getSnapshot().phase).toBe('error')
  adapter.check = async () => null
  await controller.check()
  expect(controller.getSnapshot().phase).toBe('idle')
  expect(controller.getSnapshot().checkedAt).toBeNumber()
})

test('background checks are throttled after errors; manual checks can retry', async () => {
  const { controller, calls, adapter } = fixture()
  adapter.check = async () => { calls.check++; throw new Error('offline') }
  await controller.check(true)
  await controller.check(true)
  expect(calls.check).toBe(1)
  await controller.check()
  expect(calls.check).toBe(2)
})

test('failed installation stays retryable without downloading again', async () => {
  const { controller, calls, handle } = fixture({ async install() { throw new Error('Read-only disk') } })
  await controller.check()
  await controller.restart()
  expect(controller.getSnapshot().phase).toBe('ready')
  expect(calls.relaunch).toBe(0)
  handle.install = async () => { calls.install++ }
  await controller.restart()
  expect(calls.install).toBe(1)
  expect(calls.download).toBe(1)
})

test('relaunch failure retries only relaunch, not the consumed installation', async () => {
  const { controller, adapter, calls } = fixture()
  adapter.relaunch = async () => { throw new Error('Cannot restart') }
  await controller.check()
  await controller.restart()
  expect(controller.getSnapshot().phase).toBe('restart')
  adapter.relaunch = async () => { calls.relaunch++ }
  await controller.restart()
  expect(calls.install).toBe(1)
  expect(calls.relaunch).toBe(1)
})

test('development mode cannot check, download or restart', async () => {
  let called = false
  const controller = new UpdateController({
    async check() { called = true; return null },
    async relaunch() { called = true },
  })
  await controller.check()
  await controller.restart()
  expect(called).toBe(false)
  expect(controller.getSnapshot().phase).toBe('disabled')
})

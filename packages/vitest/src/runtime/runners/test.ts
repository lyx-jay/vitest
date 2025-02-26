import type { CancelReason, Suite, Test, TestContext, VitestRunner, VitestRunnerImportSource } from '@vitest/runner'
import type { ExpectStatic } from '@vitest/expect'
import { GLOBAL_EXPECT, getState, setState } from '@vitest/expect'
import { getSnapshotClient } from '../../integrations/snapshot/chai'
import { vi } from '../../integrations/vi'
import { getFullName, getNames, getWorkerState } from '../../utils'
import { createExpect } from '../../integrations/chai/index'
import type { ResolvedConfig } from '../../types/config'
import type { VitestExecutor } from '../execute'
import { rpc } from '../rpc'

export class VitestTestRunner implements VitestRunner {
  private snapshotClient = getSnapshotClient()
  private workerState = getWorkerState()
  private __vitest_executor!: VitestExecutor
  private cancelRun = false

  constructor(public config: ResolvedConfig) {}

  importFile(filepath: string, source: VitestRunnerImportSource): unknown {
    if (source === 'setup')
      this.workerState.moduleCache.delete(filepath)
    return this.__vitest_executor.executeId(filepath)
  }

  onBeforeRun() {
    this.snapshotClient.clear()
  }

  async onAfterRun() {
    const result = await this.snapshotClient.resetCurrent()
    if (result)
      await rpc().snapshotSaved(result)
  }

  onAfterRunSuite(suite: Suite) {
    if (this.config.logHeapUsage && typeof process !== 'undefined')
      suite.result!.heap = process.memoryUsage().heapUsed
  }

  onAfterRunTest(test: Test) {
    this.snapshotClient.clearTest()

    if (this.config.logHeapUsage && typeof process !== 'undefined')
      test.result!.heap = process.memoryUsage().heapUsed

    this.workerState.current = undefined
  }

  onCancel(_reason: CancelReason) {
    this.cancelRun = true
  }

  async onBeforeRunTest(test: Test) {
    const name = getNames(test).slice(1).join(' > ')

    if (this.cancelRun)
      test.mode = 'skip'

    if (test.mode !== 'run') {
      this.snapshotClient.skipTestSnapshots(name)
      return
    }

    clearModuleMocks(this.config)
    await this.snapshotClient.setTest(test.file!.filepath, name, this.workerState.config.snapshotOptions)

    this.workerState.current = test
  }

  onBeforeRunSuite(suite: Suite) {
    if (this.cancelRun)
      suite.mode = 'skip'
  }

  onBeforeTryTest(test: Test) {
    setState({
      assertionCalls: 0,
      isExpectingAssertions: false,
      isExpectingAssertionsError: null,
      expectedAssertionsNumber: null,
      expectedAssertionsNumberErrorGen: null,
      testPath: test.suite.file?.filepath,
      currentTestName: getFullName(test),
      snapshotState: this.snapshotClient.snapshotState,
    }, (globalThis as any)[GLOBAL_EXPECT])
  }

  onAfterTryTest(test: Test) {
    const {
      assertionCalls,
      expectedAssertionsNumber,
      expectedAssertionsNumberErrorGen,
      isExpectingAssertions,
      isExpectingAssertionsError,
      // @ts-expect-error local is untyped
    } = test.context._local
      ? test.context.expect.getState()
      : getState((globalThis as any)[GLOBAL_EXPECT])
    if (expectedAssertionsNumber !== null && assertionCalls !== expectedAssertionsNumber)
      throw expectedAssertionsNumberErrorGen!()
    if (isExpectingAssertions === true && assertionCalls === 0)
      throw isExpectingAssertionsError
  }

  extendTestContext(context: TestContext): TestContext {
    let _expect: ExpectStatic | undefined
    Object.defineProperty(context, 'expect', {
      get() {
        if (!_expect)
          _expect = createExpect(context.meta)
        return _expect
      },
    })
    Object.defineProperty(context, '_local', {
      get() {
        return _expect != null
      },
    })
    return context
  }
}

function clearModuleMocks(config: ResolvedConfig) {
  const { clearMocks, mockReset, restoreMocks, unstubEnvs, unstubGlobals } = config

  // since each function calls another, we can just call one
  if (restoreMocks)
    vi.restoreAllMocks()
  else if (mockReset)
    vi.resetAllMocks()
  else if (clearMocks)
    vi.clearAllMocks()

  if (unstubEnvs)
    vi.unstubAllEnvs()
  if (unstubGlobals)
    vi.unstubAllGlobals()
}

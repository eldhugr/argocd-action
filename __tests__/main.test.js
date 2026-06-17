/**
 * Integration tests for the action entrypoint. `@actions/core` is mocked with
 * the shared fixture, and an in-process HTTP server stands in for the ArgoCD
 * REST API so `run()` can be exercised end to end without a real cluster.
 */
import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach
} from '@jest/globals'
import http from 'node:http'
import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { run } = await import('../src/main.js')

const APP = 'app.stage.comments'

// Mutable server state the individual tests configure.
let server
let baseUrl
let interactions
let appResponse // (name) => application object
let managedResponse

const helmApp = (name) => ({
  metadata: { name, annotations: {} },
  spec: {
    source: {
      repoURL: 'x',
      helm: { parameters: [{ name: 'comments.release.refName', value: 'old' }] }
    }
  },
  status: {
    sync: { status: 'Synced', revision: 'abc123' },
    health: { status: 'Healthy' },
    summary: { images: ['registry/comments:abc123'] },
    history: [
      { id: 1, revision: 'old111' },
      { id: 2, revision: 'abc123' }
    ],
    resources: [
      { kind: 'Service', namespace: 'comments', name: 'comments', version: 'v1' },
      {
        group: 'apps',
        version: 'v1',
        kind: 'Deployment',
        namespace: 'comments',
        name: 'comments'
      }
    ]
  }
})

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const { pathname } = new URL(req.url, 'http://x')
      const m = pathname.match(/^\/api\/v1\/applications\/([^/]+)(\/.*)?$/)
      const send = (obj) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(obj))
      }

      // Dex OIDC token-exchange endpoint.
      if (req.method === 'POST' && pathname === '/api/dex/token') {
        interactions.dexExchanges.push({
          auth: req.headers.authorization,
          body
        })
        return send({ access_token: 'oidc-exchanged-token' })
      }

      if (m) {
        const name = decodeURIComponent(m[1])
        const sub = m[2] || ''
        if (req.method === 'GET' && sub === '') return send(appResponse(name))
        if (req.method === 'PUT' && sub === '/spec') {
          interactions.puts.push({ name, spec: JSON.parse(body) })
          return send(JSON.parse(body))
        }
        if (req.method === 'GET' && sub === '/managed-resources') {
          return send(managedResponse)
        }
        if (req.method === 'POST' && sub === '/sync') {
          interactions.syncs.push({ name, body: JSON.parse(body || '{}') })
          return send({})
        }
        if (req.method === 'POST' && sub === '/resource/actions/v2') {
          interactions.restarts.push({ name, body: JSON.parse(body || '{}') })
          return send({})
        }
        if (req.method === 'POST' && sub === '/rollback') {
          interactions.rollbacks.push({ name, body: JSON.parse(body || '{}') })
          return send({})
        }
        if (req.method === 'DELETE' && sub === '/operation') {
          interactions.terminations.push({ name })
          return send({})
        }
      }
      res.writeHead(404)
      res.end(`no route: ${req.method} ${pathname}`)
    })
  })
  await new Promise((resolve) => server.listen(0, resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve))
})

beforeEach(() => {
  interactions = {
    puts: [],
    syncs: [],
    restarts: [],
    rollbacks: [],
    terminations: [],
    dexExchanges: []
  }
  appResponse = helmApp
  managedResponse = { items: [] }
})

/** Drive `core.getInput` from a plain map; unset inputs return ''. */
function setInputs(map) {
  core.getInput.mockImplementation((name) => map[name] ?? '')
}

const baseInputs = (extra) => ({
  application: APP,
  server: baseUrl,
  'auth-token': 'faketoken',
  ...extra
})

const sameItems = () => {
  const same = JSON.stringify({ spec: { replicas: 1 } })
  return {
    items: [
      { kind: 'A', name: '1', normalizedLiveState: same, predictedLiveState: same }
    ]
  }
}

const diffItems = () => ({
  items: [
    {
      kind: 'Deployment',
      name: 'comments',
      normalizedLiveState: JSON.stringify({ spec: { image: 'app:old' } }),
      predictedLiveState: JSON.stringify({ spec: { image: 'app:new' } })
    }
  ]
})

describe('set', () => {
  it('upserts helm parameters via PUT spec', async () => {
    setInputs(
      baseInputs({
        command: 'set',
        parameters:
          'comments.release.refName=main\ncomments.release.commitSHA=deadbeef'
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const params = interactions.puts[0].spec.source.helm.parameters
    expect(params).toContainEqual({
      name: 'comments.release.refName',
      value: 'main'
    })
    expect(params).toContainEqual({
      name: 'comments.release.commitSHA',
      value: 'deadbeef'
    })
  })
})

describe('diff', () => {
  beforeEach(() => {
    managedResponse = diffItems()
  })

  it('sets the diff output to "true" when resources differ', async () => {
    setInputs(baseInputs({ command: 'diff', refresh: 'normal' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('diff', 'true')
  })

  it('fails the step when fail-on-diff is set and a diff exists', async () => {
    setInputs(
      baseInputs({ command: 'diff', refresh: 'false', 'fail-on-diff': 'true' })
    )

    await run()

    expect(core.setOutput).toHaveBeenCalledWith('diff', 'true')
    expect(core.setFailed).toHaveBeenCalled()
  })

  it('sets the diff output to "false" when there is no difference', async () => {
    managedResponse = sameItems()
    setInputs(baseInputs({ command: 'diff', refresh: 'false' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('diff', 'false')
  })

  it('renders a unified diff block in the summary when unified-diff is set', async () => {
    setInputs(baseInputs({ command: 'diff', refresh: 'false', 'unified-diff': 'true' }))

    await run()

    const summary = core.summary.addRaw.mock.calls.map((c) => c[0]).join('\n')
    expect(summary).toContain('```diff')
    expect(summary).toContain('- spec.image: app:old')
    expect(summary).toContain('+ spec.image: app:new')
  })

  it('enriches the job log with -/+ values when unified-diff is set', async () => {
    setInputs(baseInputs({ command: 'diff', refresh: 'false', 'unified-diff': 'true' }))

    await run()

    const log = core.info.mock.calls.map((c) => c[0]).join('\n')
    expect(log).toContain('      - spec.image: app:old')
    expect(log).toContain('      + spec.image: app:new')
  })

  it('keeps the terse "type: path" job log by default', async () => {
    setInputs(baseInputs({ command: 'diff', refresh: 'false' }))

    await run()

    const log = core.info.mock.calls.map((c) => c[0]).join('\n')
    expect(log).toContain('      changed: spec.image')
    expect(log).not.toContain('app:old')
  })

  it('omits the unified diff block by default', async () => {
    setInputs(baseInputs({ command: 'diff', refresh: 'false' }))

    await run()

    const summary = core.summary.addRaw.mock.calls.map((c) => c[0]).join('\n')
    expect(summary).not.toContain('```diff')
  })
})

describe('wait', () => {
  it('returns once the app is Synced and Healthy', async () => {
    setInputs(baseInputs({ command: 'wait', timeout: '30', refresh: 'false' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('sync-status', 'Synced')
    expect(core.setOutput).toHaveBeenCalledWith('health-status', 'Healthy')
  })
})

describe('deploy (single app)', () => {
  it('restarts the chosen workloads when there is no diff and restart is set', async () => {
    managedResponse = sameItems()
    setInputs(
      baseInputs({
        command: 'deploy',
        refresh: 'false',
        timeout: '30',
        restart: 'Deployment',
        parameters: 'comments.release.commitSHA=deadbeef'
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.puts).toHaveLength(1) // set ran
    expect(interactions.syncs).toHaveLength(0) // no diff -> no sync
    expect(interactions.restarts).toHaveLength(1) // one Deployment restarted
    expect(interactions.restarts[0].body).toMatchObject({
      kind: 'Deployment',
      resourceName: 'comments',
      action: 'restart'
    })
    expect(core.setOutput).toHaveBeenCalledWith('diff', 'false')
  })

  it('does nothing on no diff when restart is off (default)', async () => {
    managedResponse = sameItems()
    setInputs(baseInputs({ command: 'deploy', refresh: 'false', timeout: '30' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.syncs).toHaveLength(0)
    expect(interactions.restarts).toHaveLength(0)
    const results = JSON.parse(
      core.setOutput.mock.calls.find((c) => c[0] === 'results')[1]
    )
    expect(results[0].action).toBe('none')
  })

  it('syncs when there is a rendered diff', async () => {
    managedResponse = diffItems()
    setInputs(
      baseInputs({ command: 'deploy', refresh: 'false', timeout: '30' })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.syncs).toHaveLength(1) // diff -> sync
    expect(interactions.restarts).toHaveLength(0)
    expect(core.setOutput).toHaveBeenCalledWith('diff', 'true')
    expect(core.setOutput).toHaveBeenCalledWith('sync-status', 'Synced')
  })

  it('honors unified-diff in the per-app job log', async () => {
    managedResponse = diffItems()
    setInputs(
      baseInputs({ command: 'deploy', refresh: 'false', timeout: '30', 'unified-diff': 'true' })
    )

    await run()

    const log = core.info.mock.calls.map((c) => c[0]).join('\n')
    expect(log).toContain('- spec.image: app:old')
    expect(log).toContain('+ spec.image: app:new')
  })
})

describe('deploy (multiple apps)', () => {
  it('deploys every application in the JSON list', async () => {
    managedResponse = sameItems()
    setInputs({
      command: 'deploy',
      server: baseUrl,
      'auth-token': 'faketoken',
      refresh: 'false',
      timeout: '30',
      restart: 'Deployment',
      applications: JSON.stringify(['app.stage.comments', 'app.dev.comments'])
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const restartedApps = interactions.restarts.map((r) => r.name).sort()
    expect(restartedApps).toEqual(['app.dev.comments', 'app.stage.comments'])

    const results = JSON.parse(
      core.setOutput.mock.calls.find((c) => c[0] === 'results')[1]
    )
    expect(results).toHaveLength(2)
    expect(results.every((r) => !r.error)).toBe(true)
  })
})

describe('deploy (failure handling)', () => {
  // Make one specific app report a failed operation so its wait throws.
  const withFailingApp = (badName) => {
    appResponse = (name) => {
      const a = helmApp(name)
      if (name === badName) {
        a.status.sync.status = 'OutOfSync'
        a.status.health.status = 'Degraded'
        a.status.operationState = { phase: 'Failed', message: 'boom: sync failed' }
      }
      return a
    }
  }

  beforeEach(() => {
    managedResponse = sameItems() // no diff -> restart path
  })

  it('fails the job when an app fails and allow-failure is off', async () => {
    withFailingApp('app.dev.comments')
    setInputs({
      command: 'deploy',
      server: baseUrl,
      'auth-token': 'faketoken',
      refresh: 'false',
      timeout: '30',
      applications: JSON.stringify(['app.stage.comments', 'app.dev.comments'])
    })

    await run()

    expect(core.setFailed).toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'partial')
    expect(core.setOutput).toHaveBeenCalledWith(
      'failed',
      JSON.stringify(['app.dev.comments'])
    )
  })

  it('does not fail the job when allow-failure is on, and reports status', async () => {
    withFailingApp('app.dev.comments')
    setInputs({
      command: 'deploy',
      server: baseUrl,
      'auth-token': 'faketoken',
      refresh: 'false',
      timeout: '30',
      'allow-failure': 'true',
      applications: JSON.stringify(['app.stage.comments', 'app.dev.comments'])
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.warning).toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('outcome', 'partial')

    const results = JSON.parse(
      core.setOutput.mock.calls.find((c) => c[0] === 'results')[1]
    )
    const bad = results.find((r) => r.app === 'app.dev.comments')
    const good = results.find((r) => r.app === 'app.stage.comments')
    expect(good.error).toBeUndefined()
    expect(bad.error).toMatch(/boom: sync failed/)
    // A report was written to the step summary.
    expect(core.summary.write).toHaveBeenCalled()
  })

  it('forces fail-fast off when allow-failure is on (sequential, failing app first)', async () => {
    withFailingApp('app.bad')
    setInputs({
      command: 'deploy',
      server: baseUrl,
      'auth-token': 'faketoken',
      refresh: 'false',
      timeout: '30',
      restart: 'Deployment',
      parallel: 'false',
      'fail-fast': 'true', // explicitly on - allow-failure must override it
      'allow-failure': 'true',
      applications: JSON.stringify(['app.bad', 'app.good'])
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const results = JSON.parse(
      core.setOutput.mock.calls.find((c) => c[0] === 'results')[1]
    )
    // The good app after the failing one is still attempted (no early break).
    expect(results.map((r) => r.app)).toEqual(['app.bad', 'app.good'])
    expect(results.find((r) => r.app === 'app.bad').error).toMatch(/boom/)
    expect(results.find((r) => r.app === 'app.good').error).toBeUndefined()
  })
})

describe('sync', () => {
  it('syncs with options and waits', async () => {
    setInputs(
      baseInputs({
        command: 'sync',
        refresh: 'false',
        timeout: '30',
        prune: 'true',
        force: 'true',
        'sync-options': 'CreateNamespace=true'
      })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.syncs).toHaveLength(1)
    expect(interactions.syncs[0].body).toMatchObject({
      prune: true,
      syncOptions: { items: ['CreateNamespace=true'] },
      strategy: { apply: { force: true } }
    })
    expect(core.setOutput).toHaveBeenCalledWith('sync-status', 'Synced')
  })

  it('does not wait for a dry-run sync', async () => {
    setInputs(
      baseInputs({ command: 'sync', 'dry-run': 'true', timeout: '30' })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.syncs[0].body).toMatchObject({ dryRun: true })
  })
})

describe('get', () => {
  it('exposes status, images and history as outputs', async () => {
    setInputs(baseInputs({ command: 'get', refresh: 'false' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.setOutput).toHaveBeenCalledWith('sync-status', 'Synced')
    expect(core.setOutput).toHaveBeenCalledWith('health-status', 'Healthy')
    expect(core.setOutput).toHaveBeenCalledWith('revision', 'abc123')
    expect(core.setOutput).toHaveBeenCalledWith(
      'images',
      JSON.stringify(['registry/comments:abc123'])
    )
  })
})

describe('rollback', () => {
  it('rolls back to the previous deployment by default and waits', async () => {
    setInputs(baseInputs({ command: 'rollback', timeout: '30' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.rollbacks).toHaveLength(1)
    expect(interactions.rollbacks[0].body).toMatchObject({ id: 1 })
    expect(core.setOutput).toHaveBeenCalledWith('sync-status', 'Synced')
  })

  it('rolls back to an explicit history id', async () => {
    setInputs(
      baseInputs({ command: 'rollback', 'rollback-id': '2', timeout: '30' })
    )

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.rollbacks[0].body).toMatchObject({ id: 2 })
  })
})

describe('history', () => {
  it('sets the history output', async () => {
    setInputs(baseInputs({ command: 'history' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    const history = JSON.parse(
      core.setOutput.mock.calls.find((c) => c[0] === 'history')[1]
    )
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({ id: 2, revision: 'abc123' })
  })
})

describe('terminate-op', () => {
  it('terminates the running operation', async () => {
    setInputs(baseInputs({ command: 'terminate-op' }))

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.terminations).toHaveLength(1)
    expect(interactions.terminations[0].name).toBe(APP)
  })
})

describe('auth (oidc)', () => {
  const ORIGINAL_ENV = process.env.ACTIONS_ID_TOKEN_REQUEST_URL

  beforeEach(() => {
    // Presence of this env var is how the action knows OIDC is available.
    process.env.ACTIONS_ID_TOKEN_REQUEST_URL = 'https://token.example/req'
    core.getIDToken.mockResolvedValue('gh-id-token')
  })

  afterAll(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    else process.env.ACTIONS_ID_TOKEN_REQUEST_URL = ORIGINAL_ENV
  })

  it('exchanges a GitHub ID token at the Dex endpoint and uses the result', async () => {
    setInputs({
      command: 'get',
      application: APP,
      server: baseUrl,
      'auth-method': 'oidc',
      refresh: 'false'
    })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(core.getIDToken).toHaveBeenCalled()
    expect(interactions.dexExchanges).toHaveLength(1)
    const exchange = interactions.dexExchanges[0]
    expect(exchange.body).toContain('subject_token=gh-id-token')
    expect(exchange.body).toContain('connector_id=github-actions')
    expect(exchange.body).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange'
    )
    // `argo-cd-cli:` base64-encoded.
    expect(exchange.auth).toBe(`Basic ${Buffer.from('argo-cd-cli:').toString('base64')}`)
    // The command ran with the exchanged token.
    expect(core.setOutput).toHaveBeenCalledWith('sync-status', 'Synced')
  })

  it('infers oidc when no other credentials are provided', async () => {
    setInputs({ command: 'get', application: APP, server: baseUrl, refresh: 'false' })

    await run()

    expect(core.setFailed).not.toHaveBeenCalled()
    expect(interactions.dexExchanges).toHaveLength(1)
  })
})

describe('dispatch', () => {
  it('fails on an unknown command', async () => {
    setInputs(baseInputs({ command: 'bogus' }))

    await run()

    expect(core.setFailed).toHaveBeenCalledWith(
      expect.stringMatching(/Unknown command/)
    )
  })
})

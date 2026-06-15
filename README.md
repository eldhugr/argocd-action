# argocd-action

**A native JavaScript GitHub Action that drives the ArgoCD REST API directly - no CLI binary, no container image.**

It implements the subset of `argocd app` that deployment pipelines actually use,
with structured inputs/outputs instead of parsing CLI exit codes in shell. It
talks to the same HTTP gateway the `argocd` CLI uses
(`https://<server>/api/v1/...`).

## Contents

- [Quick start](#quick-start)
- [Commands](#commands)
  - [`deploy`](#deploy---the-umbrella-command)
  - [`sync`](#sync---sync-with-options)
  - [`rollback`](#rollback---roll-back-to-a-previous-deployment)
  - [`get` / `history` / `terminate-op`](#get--history--terminate-op)
- [Authentication](#authentication)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [How diffing works](#how-diffing-works)
- [Development](#development)
- [Roadmap](#roadmap)

## Quick start

Published as `eldhugr/argocd-action`; pin to a release tag (`@v1`).

```yaml
- name: Deploy
  uses: eldhugr/argocd-action@v1
  with:
    command: deploy
    application: app.stage.comments
    parameters: |
      comments.release.refName=${{ env.ref_name }}
      comments.release.commitSHA=${{ env.sha }}
    timeout: '600'
  env:
    ARGOCD_SERVER: ${{ vars.ARGOCD_SERVER }}
    ARGOCD_AUTH_TOKEN: ${{ secrets.ARGOCD_AUTH_TOKEN }}
```

> Please note that the examples below omit the connection `env:` for brevity. Every step needs
> the server and credentials, set either per-step or on the job:
>
> ```yaml
> env:
>   ARGOCD_SERVER: ${{ vars.ARGOCD_SERVER }}
>   ARGOCD_AUTH_TOKEN: ${{ secrets.ARGOCD_AUTH_TOKEN }}
> ```
>
> See [Authentication](#authentication) for token, password, and OIDC options.

## Commands

Every run executes one `command`. `deploy` is the umbrella that most pipelines
use; the others are the individual steps it composes, exposed for standalone use.

| command        | what it does                                                                          |
|----------------|---------------------------------------------------------------------------------------|
| `deploy`       | Umbrella: `set` → `diff` → (sync if diff / restart if not) → `wait`. One app or many. |
| `set`          | Set Helm parameters on an application (`spec.source.helm.parameters`).                |
| `diff`         | Report whether the live state differs from target (sets a `diff` output).             |
| `sync`         | Sync the app with full sync options (prune, force, server-side, …), then wait.        |
| `wait`         | Poll until the app is `Synced` + `Healthy` with no in-flight operation.               |
| `rollback`     | Roll back to a previous deployment (by id, revision, or the previous one).            |
| `get`          | Read-only status fetch → sets status / revision / images / history outputs.           |
| `history`      | List the app's deployment history (sets the `history` output).                        |
| `terminate-op` | Terminate the app's currently running sync operation.                                 |

### `deploy` - the umbrella command

`deploy` replaces a whole "update image settings and deploy" shell step:

```bash
argocd app set "$app" --parameter ...
argocd app diff "$app" --refresh && argocd app actions run "$app" restart --kind Deployment || argocd app sync "$app"
argocd app wait "$app" --timeout 600
```

It runs `set` → `diff` → (**rendered diff ⇒ sync** / **no diff ⇒ restart the
workloads named by `restart`, or nothing**) → `wait`, end to end:

```yaml
- name: Deploy
  uses: eldhugr/argocd-action@v1
  with:
    command: deploy
    application: app.stage.comments
    parameters: |
      comments.release.refName=${{ env.ref_name }}
      comments.release.commitSHA=${{ env.sha }}
    restart: Deployment # roll Deployments when the image tag is unchanged (no diff)
    timeout: '600'
```

`restart` is `false` by default, so a no-diff deploy does nothing (the app is
already in its desired state). Set it to an explicit kind or comma-separated
list (`Deployment`, `StatefulSet`, `Deployment,StatefulSet`) to force a rollout
restart of those workloads when there's no rendered diff - useful when the image
tag is a moving ref (e.g., a branch) rather than an immutable SHA.

#### Multiple applications

Pass `applications` - a JSON array or newline/comma-separated list - instead of
`application`. Every target is deployed with the **same** settings
(`parameters`, `timeout`, `refresh`, `restart`, `wait-for-*`, …); there are no
per-application overrides.

```yaml
- name: Deploy all clusters
  id: deploy
  uses: eldhugr/argocd-action@v1
  with:
    command: deploy
    parameters: |
      comments.release.refName=${{ env.ref_name }}
      comments.release.commitSHA=${{ env.sha }}
    timeout: '900'
    # parallel: 'false'     # deploy one at a time (default is concurrent)
    allow-failure: 'true'   # deploy every app and report, even if some fail
    applications: |
      app.stage.comments
      app.dev.comments
      app.prod.comments
```

#### Failure handling and status reporting

- **`allow-failure: true`** keeps the job green even when some applications fail:
  the remaining apps are still deployed (it implies `fail-fast: false`) and the
  failures are reported rather than aborting the step. With it off (default), the
  step fails if any application fails - `fail-fast` then controls whether the
  sequential run stops at the first failure or attempts the rest first.
- **Status report** - a per-application table (deployed / failed, action, sync,
  health, failure reason) is written to the **GitHub step summary**, and logged
  with ✓/✗ markers. Reasons come from the app's operation message, conditions,
  and any non-Healthy resources.
- **Outputs** for downstream steps:
  - `results` - JSON array of `{ app, diff, action, syncStatus, healthStatus, revision }`, or `{ app, error }` for failures.
  - `outcome` - `success` | `partial` | `failure`.
  - `failed` - JSON array of the application names that failed.
  - A single-app deploy also sets the scalar `diff` / `sync-status` / `health-status` / `revision`.

```yaml
- if: ${{ steps.deploy.outputs.outcome != 'success' }}
  run: |
    echo "Failed: ${{ steps.deploy.outputs.failed }}"
```

> Please note that the restart/sync branch mirrors the shell `&&`/`||` exactly **except** the rare
> "restart failed ⇒ fall back to sync" case: here a restart error fails the app
> instead of falling through to a sync.

### `sync` - sync with options

A standalone sync exposing the full set of `argocd app sync` flags as inputs. It
triggers the sync and waits for it to settle (honouring `wait-for-*` and
`timeout`); a `dry-run` sync returns without waiting.

```yaml
- name: Sync with prune + server-side apply
  uses: eldhugr/argocd-action@v1
  with:
    command: sync
    application: app.stage.comments
    prune: 'true'
    server-side: 'true'
    sync-options: |
      CreateNamespace=true
```

The same sync options (`prune`, `force`, `replace`, `server-side`,
`apply-out-of-sync-only`, `sync-options`, `strategy`) also apply to the sync
step performed by `deploy`.

### `rollback` - roll back to a previous deployment

```yaml
- name: Roll back to the previous deployment
  uses: eldhugr/argocd-action@v1
  with:
    command: rollback
    application: app.stage.comments
    # rollback-id: '7'      # explicit history id, or
    # revision: <git-sha>   # roll back to a specific revision, else previous
    prune: 'true'
```

### `get` / `history` / `terminate-op`

`get` is a read-only status fetch; `history` emits the deployment history (the
data `rollback` resolves ids from); `terminate-op` cancels a stuck sync.

```yaml
- name: Read current status
  id: status
  uses: eldhugr/argocd-action@v1
  with:
    command: get
    application: app.stage.comments
# steps.status.outputs.sync-status / health-status / revision / images / history
```

## Authentication

Credentials are resolved from inputs first, then the standard `ARGOCD_*`
environment variables (so existing workflow `env:` blocks keep working). The
method is set by `auth-method`, or inferred when it is unset:

| method     | credentials                                                   | notes                                 |
|------------|---------------------------------------------------------------|---------------------------------------|
| `token`    | `auth-token` / `$ARGOCD_AUTH_TOKEN`                           | Long-lived bearer token.              |
| `password` | `username`+`password` / `$ARGOCD_USERNAME`+`$ARGOCD_PASSWORD` | Logs in via `POST /api/v1/session`.   |
| `oidc`     | none - minted per run                                         | GitHub OIDC federation (recommended). |

When `auth-method` is unset it is inferred: token → password → OIDC (if the job
can mint an ID token).

### OIDC token federation (recommended)

Instead of storing a long-lived ArgoCD token as a secret, the action mints a
short-lived GitHub Actions ID token per run and exchanges it for an ArgoCD token
at the server's Dex endpoint (`POST /api/dex/token`). The exchange is done
natively - no `curl`, `jq`, or `argocd` CLI required (unlike the
[upstream docs](https://argo-cd.readthedocs.io/en/latest/operator-manual/user-management/github-actions/)).

```yaml
jobs:
  deploy:
    permissions:
      id-token: write # required: lets the job request an OIDC ID token
      contents: read
    steps:
      - uses: eldhugr/argocd-action@v1
        with:
          command: deploy
          application: app.stage.comments
          auth-method: oidc # optional; inferred when no token/password is set
        env:
          ARGOCD_SERVER: ${{ vars.ARGOCD_SERVER }}
```

**Server-side prerequisites** (one-time, by an ArgoCD operator):

<details>
<summary>1. Dex connector in the <code>argocd-cm</code> ConfigMap</summary>

```yaml
connectors:
  - type: oidc
    id: github-actions # matches `oidc-connector-id` (default)
    name: GitHub Actions
    config:
      issuer: https://token.actions.githubusercontent.com/
```

</details>

<details>
<summary>2. RBAC policies in <code>argocd-rbac-cm</code> (ArgoCD ≥ v3.0)</summary>

For a repo deploying from `main`, the subject is
`repo:my-org/my-repo:ref:refs/heads/main`:

```
# policy.csv  (scope */* to <project>/* to restrict apps)
p, repo:my-org/my-repo:ref:refs/heads/main, applications, get,      */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, sync,     */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, update,   */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, override, */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, action/*, */*, allow
```

Per command: `get` (all read paths) · `sync` (`sync`/`deploy`/`rollback`/`terminate-op`)
· `update` (the `PUT /spec` write in `set`/`deploy`) · `override` (parameter
overrides / `rollback`) · `action/*` (the `restart` resource action). Drop the
lines for commands you don't use. The subject ties to the trigger - use
`...:ref:refs/heads/<branch>` for other branches, or `repo:my-org/my-repo:pull_request`
for PR-triggered runs. See the
[RBAC reference](https://argo-cd.readthedocs.io/en/latest/operator-manual/rbac/)
for the exact action each operation needs in your ArgoCD version.

</details>

Override `oidc-client-id` (default `argo-cd-cli`), `oidc-connector-id` (default
`github-actions`), or `oidc-audience` if your server uses different values.

## Inputs

### Common

| input         | required | values                    | default | description                                              |
|---------------|----------|---------------------------|---------|----------------------------------------------------------|
| `command`     | yes      | see [Commands](#commands) |         | Sub-command to run                                       |
| `application` | yes\*    | application name          |         | \*Not required for `deploy` when `applications` is given |

### Connection & authentication

| input                   | values                          | default                                 | description                                         |
|-------------------------|---------------------------------|-----------------------------------------|-----------------------------------------------------|
| `server`                | host or URL                     | `$ARGOCD_SERVER`                        | Server host, with or without scheme                 |
| `auth-method`           | `token` \| `password` \| `oidc` | inferred                                | Auth method; inferred from credentials present      |
| `auth-token`            | string                          | `$ARGOCD_AUTH_TOKEN`                    | Bearer token                                        |
| `username` / `password` | string                          | `$ARGOCD_USERNAME` / `$ARGOCD_PASSWORD` | Password login (used only when no token)            |
| `oidc-audience`         | string                          |                                         | (`oidc`) audience for the requested GitHub ID token |
| `oidc-client-id`        | string                          | `argo-cd-cli`                           | (`oidc`) Dex client id for the token exchange       |
| `oidc-connector-id`     | string                          | `github-actions`                        | (`oidc`) Dex connector id configured on the server  |
| `insecure`              | `true` \| `false`               | `false` (`$ARGOCD_INSECURE`)            | Skip TLS verification                               |
| `app-namespace`         | string                          |                                         | `appNamespace` for apps-in-any-namespace            |

### Set parameters - `set`, `deploy`

| input                             | values                 | description                         |
|-----------------------------------|------------------------|-------------------------------------|
| `parameters`                      | `name=value` per line  | Helm parameters to set              |
| `source-name` / `source-position` | string / 1-based index | Target source for multi-source apps |

### Sync - `sync`, `deploy` (sync step), some apply to `rollback`

| input                    | values                      | default | description                                                      |
|--------------------------|-----------------------------|---------|------------------------------------------------------------------|
| `prune`                  | `true` \| `false`           | `false` | Prune resources removed from Git (also `rollback`)               |
| `force`                  | `true` \| `false`           | `false` | Force apply during sync                                          |
| `replace`                | `true` \| `false`           | `false` | `Replace=true` sync option                                       |
| `server-side`            | `true` \| `false`           | `false` | `ServerSideApply=true` sync option                               |
| `apply-out-of-sync-only` | `true` \| `false`           | `false` | `ApplyOutOfSyncOnly=true` sync option                            |
| `sync-options`           | `Name=value` per line/comma |         | Extra sync options (e.g. `CreateNamespace=true`)                 |
| `strategy`               | `apply` \| `hook`           | `apply` | Sync strategy                                                    |
| `dry-run`                | `true` \| `false`           | `false` | Don't apply changes; don't wait (also `rollback`)                |
| `revision`               | git revision                |         | Target revision (`sync`) / revision to roll back to (`rollback`) |

### Diff & wait - `diff`, `wait`, `deploy`, `get`, `rollback`

| input                                                      | values                        | default  | description                                 |
|------------------------------------------------------------|-------------------------------|----------|---------------------------------------------|
| `refresh`                                                  | `false` \| `normal` \| `hard` | `normal` | Refresh the app before diff/wait/get        |
| `fail-on-diff`                                             | `true` \| `false`             | `false`  | (`diff`) fail the step when a diff is found |
| `timeout`                                                  | seconds (integer)             | `600`    | Max time to wait for Synced/Healthy         |
| `wait-for-sync` / `wait-for-health` / `wait-for-operation` | `true` \| `false`             | `true`   | Conditions to wait on                       |

### Rollback - `rollback`

| input         | values               | description                                            |
|---------------|----------------------|--------------------------------------------------------|
| `rollback-id` | history id (integer) | Explicit deployment id; else `revision`, else previous |

### Deploy (multi-app & failure) - `deploy`

| input           | values                           | default | description                                                                     |
|-----------------|----------------------------------|---------|---------------------------------------------------------------------------------|
| `applications`  | JSON array \| newline/comma list |         | App names; overrides `application`                                              |
| `restart`       | `false` \| kind / comma-list     | `false` | On no diff, restart these workloads                                             |
| `parallel`      | `true` \| `false`                | `true`  | Deploy multiple apps concurrently (`false` = one-at-a-time)                     |
| `fail-fast`     | `true` \| `false`                | `true`  | Stop after the first failure (sequential); ignored with `allow-failure`         |
| `allow-failure` | `true` \| `false`                | `false` | Don't fail the job on app failures; deploy the rest. Implies `fail-fast: false` |

## Outputs

| output          | description                                                 |
|-----------------|-------------------------------------------------------------|
| `diff`          | `"true"`/`"false"` - whether `diff` found differences       |
| `sync-status`   | last observed sync status                                   |
| `health-status` | last observed health status                                 |
| `revision`      | synced revision                                             |
| `images`        | (`get`) JSON array of deployed container images             |
| `history`       | (`get`, `history`) JSON array of deployment history entries |
| `results`       | (`deploy`) JSON array of per-application results            |
| `outcome`       | (`deploy`) `success` \| `partial` \| `failure`              |
| `failed`        | (`deploy`) JSON array of application names that failed      |

## How diffing works

`diff` does **not** reimplement ArgoCD's normalization engine. It relies on the
server-computed `normalizedLiveState` (live, with `ignoreDifferences` and
normalizers already applied) vs `predictedLiveState` (target) from the
`managed-resources` endpoint, and reports a structural difference between them.
This faithfully reproduces the diff / no-diff _decision_ the pipeline depends on.

## Development

This repo follows the
[`actions/javascript-action`](https://github.com/actions/javascript-action)
template conventions: ESM source under `src/` (`index.js` → `main.js`'s
`run()`), Rollup bundling, and Jest tests with `@actions/core` mocked via
`__fixtures__/`. The target runtime comes from `engines.node` in `package.json`.

```bash
npm ci
npm test         # jest (unit + in-process mock-API integration)
npm run coverage # jest with coverage report
npm run bundle   # rollup -> dist/index.js
npm run all      # test + bundle
```

`dist/` is committed - GitHub runs the bundled `dist/index.js` directly. The
`check-dist` workflow fails if `dist/` is stale, so **always `npm run bundle`
before committing**.

> Please note that the template's live `test-action` CI job is omitted because exercising the
> commands needs a real ArgoCD server; the in-process mock-API integration test
> in `__tests__/main.test.js` covers that path instead.

## Roadmap

- Optional unified (pretty) diff rendering for human-readable PR comments.
- Resource-scoped sync (`--resource group:kind:name`) and `unset` for parameters.

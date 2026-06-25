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
- [Connection reliability](#connection-reliability)
- [Development](#development)

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

| command        | what it does                                                                             |
|----------------|------------------------------------------------------------------------------------------|
| `deploy`       | Umbrella: `set` -> `diff` -> (sync if diff / restart if not) -> `wait`. One app or many. |
| `set`          | Set/unset Helm parameters or Kustomize images on an application's source.                |
| `diff`         | Report whether the live state differs from target (sets a `diff` output).                |
| `sync`         | Sync the app with full sync options (prune, force, server-side, …), then wait.           |
| `wait`         | Poll until the app is `Synced` + `Healthy` with no in-flight operation.                  |
| `rollback`     | Roll back to a previous deployment (by id, revision, or the previous one).               |
| `get`          | Read-only status fetch -> sets status / revision / images / history outputs.             |
| `history`      | List the app's deployment history (sets the `history` output).                           |
| `terminate-op` | Terminate the app's currently running sync operation.                                    |

#### Step summaries

Every command writes a section to the **GitHub step summary** (`$GITHUB_STEP_SUMMARY`):
a short headline plus a table tailored to the command-deployed image(s) for
`deploy`/`sync`/`rollback`/`wait`/`get`, changed resources for `diff`, the
parameters set for `set`, and the deployment history for `history`. The
application name links to its ArgoCD page. When a job runs several steps, each
block is self-contained and separated by a horizontal rule, so the steps read
cleanly stacked together.

For `diff`, set `unified-diff: true` to add a field-level `+`/`-` diff in a
`diff`-fenced code block beneath the resource table - GitHub colours the old/new
values, so a reviewer sees exactly what changed (e.g. the image tag) rather than
just a count. The same flag also expands the job log itself, from a `type: path`
listing to `-`/`+` value lines under each resource. `deploy` honours the flag
too: it expands the per-application diff it logs, and adds the same `+`/`-` block
to its step summary beneath the status table, one section per application that
had a rendered diff. Values of `Secret` resources are masked (`***`) everywhere;
only the changed key is named, never its value.

### `deploy` - the umbrella command

`deploy` replaces a whole "update image settings and deploy" shell step:

```bash
argocd app set "$app" --parameter ...
argocd app diff "$app" --refresh && argocd app actions run "$app" restart --kind Deployment || argocd app sync "$app"
argocd app wait "$app" --timeout 600
```

It runs `set` -> `diff` -> (**rendered diff => sync** / **no diff => restart the
workloads named by `restart`, or nothing**) -> `wait`, end to end:

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

`restart` is `false` by default, so a no-diff `deploy` does nothing (the app is
already in its desired state). Set it to an explicit kind or comma-separated
list (`Deployment`, `StatefulSet`, `Deployment,StatefulSet`) to force a rollout
restart of those workloads when there's no rendered diff - useful when the image
tag is a moving ref (e.g., a branch) rather than an immutable SHA.

> Please note that a rollout restart patches the live workload (a
> `kubectl.kubernetes.io/restartedAt` annotation), which ArgoCD reports as
> `OutOfSync` unless that field is covered by `ignoreDifferences`. With the
> default `wait-for-sync: true`, the post-restart wait would then never reach
> `Synced` and time out. When you rely on `restart`, either set `wait-for-sync:
> 'false'` (wait on health only) or make sure the annotation is ignored on the
> server, so the wait tracks the rollout rather than a self-inflicted drift.

#### Multiple applications

Pass `applications` - a JSON array or newline/comma-separated list - instead of
`application`. Every target is deployed with the **same** settings
(`parameters`, `timeout`, `refresh`, `restart`, `wait-for-*`, …); there are no
per-application overrides.

With `parallel` (the default), applications deploy concurrently through a queue
that runs at most 8 at a time, so a long list won't open an unbounded number of
connections to the ArgoCD gateway; the rest wait their turn. Set `parallel:
'false'` to deploy strictly one at a time.

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
- **Status report** - a per-application table (result, sync, health, and a details
  column) is written to the **GitHub step summary**, and logged with ✓/✗ markers.
  The result says what happened - `Deployed`, `Restarted`, `No change`, or `Failed`.
  The application name links to its ArgoCD page. On success the details column
  shows the container image transition (`old -> new`, shortened to `basename:tag`)
  when an image changed, otherwise the running image(s) (first + `(+N)`); on
  failure it holds the reason, taken from the app's operation message, conditions,
  and any non-Healthy resources.
- **Outputs** for downstream steps:
  - `results` - JSON array of `{ app, diff, action, syncStatus, healthStatus, revision, images }`, or `{ app, error }` for failures.
  - `outcome` - `success` | `partial` | `failure`.
  - `failed` - JSON array of the application names that failed.
  - A single-app `deploy` also sets the scalar `diff` / `sync-status` / `health-status` / `revision`.

```yaml
- if: ${{ steps.deploy.outputs.outcome != 'success' }}
  run: |
    echo "Failed: ${{ steps.deploy.outputs.failed }}"
```

> Please note that the restart/sync branch mirrors the shell `&&`/`||` exactly **except** the rare
> "restart failed => fall back to sync" case: here a restart error fails the app
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
`apply-out-of-sync-only`, `sync-options`, `strategy`, `resources`) also apply to
the sync step performed by `deploy`.

To sync only part of an application, pass `resources` - one `[group:]kind:name`
per line or comma-separated, mirroring `argocd app sync --resource`. The group is
blank for core resources, written as `:Service:web` or just `Service:web`:

```yaml
- name: Sync only the web Deployment and its Service
  uses: eldhugr/argocd-action@v1
  with:
    command: sync
    application: app.stage.comments
    resources: |
      apps:Deployment:web
      :Service:web
```

> Please note that `server-side`, `replace`, and `apply-out-of-sync-only` are convenience flags
> that append `ServerSideApply=true`, `Replace=true`, and `ApplyOutOfSyncOnly=true`
> to the same option list `sync-options` feeds - so `server-side: true` is exactly
> equivalent to `sync-options: ServerSideApply=true`.
>
> If the same option is supplied both ways, it is **consolidated** to a single
> entry, not duplicated. On a genuine conflict the **typed flag wins** (it is
> applied last), and a warning is logged - e.g. `server-side: true` with
> `sync-options: ServerSideApply=false` syncs server-side.
>
> The flags can only turn an option **on**: a `false`/unset flag emits nothing, so
> it never removes a `sync-options` entry (`server-side: false` with
> `sync-options: ServerSideApply=true` still applies server-side). To force an
> option **off**, pass it through `sync-options` (e.g. `ServerSideApply=false`) and
> don't also set the flag. Prefer one path per option.
>
> A `sync-options` key ArgoCD doesn't recognise (e.g., a typo like
> `ServerSideAply=true`) logs a warning but does not fail the step.
>
> `prune`, `dry-run`, and `revision` are different: they map to top-level
> sync-request fields rather than the option list, so they have no `sync-options`
> string form.

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
method is chosen by `auth-method`, one of:

| method     | credentials                                                   | notes                                 |
|------------|---------------------------------------------------------------|---------------------------------------|
| `token`    | `auth-token` / `$ARGOCD_AUTH_TOKEN`                           | Long-lived bearer token.              |
| `password` | `username`+`password` / `$ARGOCD_USERNAME`+`$ARGOCD_PASSWORD` | Logs in via `POST /api/v1/session`.   |
| `oidc`     | none - minted per run                                         | GitHub OIDC federation.               |

When `auth-method` is unset, it is inferred from the credentials present, in the
order token -> password -> OIDC (OIDC only if the job can mint an ID token).

### OIDC token federation

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

That is the whole client side - no `ARGOCD_AUTH_TOKEN` secret. What happens per run:

1. The job asks GitHub for a short-lived OIDC ID token (granted by
   `permissions: id-token: write`). Its `sub` claim identifies the workflow, e.g.
   `repo:my-org/my-repo:ref:refs/heads/main`.
2. The action exchanges that token at `POST /api/dex/token` using an OAuth 2.0
   token exchange (`grant_type=urn:ietf:params:oauth:grant-type:token-exchange`),
   as client `argo-cd-cli` through the `github-actions` connector.
3. Dex verifies the token against GitHub's issuer keys, maps the `sub` claim to an
   ArgoCD user (and any groups), and returns a short-lived ArgoCD `access_token`.
4. The action uses that `access_token` as the Bearer for the rest of the run.
   Nothing long-lived is stored anywhere.

For this to succeed, an ArgoCD operator wires up two things at once: a Dex connector
that trusts GitHub as an issuer, and RBAC that grants the workflow's identity the
verbs it needs.

**Server-side prerequisites** (one-time, by an ArgoCD operator):

<details>
<summary>1. Dex connector in the <code>argocd-cm</code> ConfigMap</summary>

Add this to the `dex.config` key of the `argocd-cm` ConfigMap (its value is a
YAML string). The ConfigMap's `url` field must also be set to ArgoCD's external
URL, since Dex derives its issuer from it.

```yaml
connectors:
  - type: oidc
    id: github-actions                 # must match the action's `oidc-connector-id` input (which defaults to `github-actions`)
    name: GitHub Actions
    config:
      issuer: https://token.actions.githubusercontent.com
      scopes:
        - openid
      userNameKey: sub                  # the RBAC subject is the token's `sub` claim
      insecureSkipEmailVerified: true   # GitHub ID tokens carry no verified email
```

`userNameKey: sub` tells Dex to identify the caller by GitHub's `sub` claim,
which is exactly what the RBAC policies in step 2 match on. No
`clientID`/`clientSecret` is configured: the token-exchange path validates the
incoming GitHub ID token against the issuer's public keys directly, and does not
check its audience.

</details>

<details>
<summary>2. RBAC policies in <code>argocd-rbac-cm</code> (ArgoCD v3.0+)</summary>

With `userNameKey: sub`, the policy subject is GitHub's `sub` claim, whose exact
shape depends on what triggered the workflow:

| workflow trigger         | `sub` claim (the RBAC subject)               |
|--------------------------|----------------------------------------------|
| push to a branch         | `repo:my-org/my-repo:ref:refs/heads/main`    |
| push of a tag            | `repo:my-org/my-repo:ref:refs/tags/v1.2.3`   |
| pull request             | `repo:my-org/my-repo:pull_request`           |
| job using an environment | `repo:my-org/my-repo:environment:production` |

ArgoCD matches the subject **exactly** (no glob), so every trigger that deploys
needs its own line. For a repo deploying from `main`, add these to the
`policy.csv` key of `argocd-rbac-cm`:

```
# Narrow the object from */* to <project>/* to restrict which apps are reachable.
p, repo:my-org/my-repo:ref:refs/heads/main, applications, get,      */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, sync,     */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, update,   */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, override, */*, allow
p, repo:my-org/my-repo:ref:refs/heads/main, applications, action/*, */*, allow
```

Each verb backs specific commands - keep only the lines you use:

| RBAC verb                | needed by                                                          |
|--------------------------|--------------------------------------------------------------------|
| `applications, get`      | `get`, `history`, `diff`, `wait`, and the reads every command does |
| `applications, sync`     | `sync`, `deploy` (its sync step), `rollback`, `terminate-op`       |
| `applications, update`   | `set`, `deploy` (the `PUT /spec` parameter write)                  |
| `applications, override` | parameter overrides, `rollback`                                    |
| `applications, action/*` | the `restart` resource action used by `deploy`                     |

For another branch use `...:ref:refs/heads/<branch>`; for PR-triggered runs use
`repo:my-org/my-repo:pull_request`. See the
[RBAC reference](https://argo-cd.readthedocs.io/en/latest/operator-manual/rbac/)
for the exact action each operation needs in your ArgoCD version. To grant a
whole org without listing every subject, see (3) below.

</details>

<details>
<summary>3. Org-wide access without per-repo policies (optional)</summary>

A wildcard subject like `repo:my-org/*` never matches, because ArgoCD compares
the subject as an exact string. To let **every repo in an org** (on any branch,
tag, or PR) use the action without enumerating subjects, map a stable claim to an
ArgoCD **group** and write the policy against the group instead.

GitHub's ID token carries a `repository_owner` claim (the org/username). Surface
it as a group by adding `claimMapping` to the connector from step 1:

```yaml
connectors:
  - type: oidc
    id: github-actions
    name: GitHub Actions
    config:
      issuer: https://token.actions.githubusercontent.com
      scopes:
        - openid
      userNameKey: sub
      insecureSkipEmailVerified: true
      insecureEnableGroups: true
      claimMapping:
        groups: repository_owner   # every repo under the org shares this group
```

`insecureEnableGroups: true` is mandatory - the Dex OIDC connector ignores
`claimMapping.groups` (and emits no `groups` claim at all) unless it is set, so
without it the group policy below never matches. `repository_owner` is a single
string rather than a list; Dex wraps a scalar `groups` claim into a one-element
group automatically, so the group ends up named after the org (`my-org`).

Then grant the group in `policy.csv`. ArgoCD checks policies against the subject
**and** every group, so the verbs are identical to (2) - only the subject changes
from the `repo:...` string to the org name:

```
p, my-org, applications, get,      */*, allow
p, my-org, applications, sync,     */*, allow
p, my-org, applications, update,   */*, allow
p, my-org, applications, override, */*, allow
p, my-org, applications, action/*, */*, allow
```

Or, alternatively:
```
p, role:deployer, applications, get,      */*, allow
p, role:deployer, applications, sync,     */*, allow
p, role:deployer, applications, update,   */*, allow
p, role:deployer, applications, override, */*, allow
p, role:deployer, applications, action/*, */*, allow

g, my-org, role:deployer
```

- **Blast radius** - this trusts every workflow in every org repo, on any ref, to
  act on every app (`*/*`). Scope the object to a project (`<project>/*`) and drop
  unused verbs to contain it.
- **Fork PRs are excluded automatically** - GitHub does not grant `id-token:
  write` to `pull_request` runs from forks, so external contributors can't mint a
  usable token regardless of policy.
- **Confirm the group before relying on it** - groups-claim handling varies a
  little across Dex versions. After a first run, check the ArgoCD server logs (or
  start with a `get`-only policy) to confirm `my-org` appears as a group on the
  exchanged token.

</details>

Override `oidc-client-id` (default `argo-cd-cli`) or `oidc-connector-id` (default
`github-actions`) if your server uses different values. `oidc-audience` sets the
audience of the minted GitHub token; it is rarely necessary, because Dex does not
verify the audience during the token exchange - set it only if something in front
of your ArgoCD server (a proxy or gateway) requires a specific `aud`.

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

| input                             | values                        | description                                       |
|-----------------------------------|-------------------------------|---------------------------------------------------|
| `parameters`                      | `name=value` per line         | Helm parameters to set                            |
| `unset-parameters`                | name per line/comma           | Helm parameter names to remove (set/unset in one) |
| `kustomize-images`                | image override per line/comma | Kustomize images to set (`--kustomize-image`)     |
| `source-name` / `source-position` | string / 1-based index        | Target source for multi-source apps               |

Values for secret-looking parameter names (containing `password`, `token`,
`secret`, `credential`, `auth`, ... or ending in `key`) are masked as `***` in
the step summary and registered with `core.setSecret` so GitHub redacts them in
the logs too.

`unset-parameters` removes Helm parameters by name (one per line or comma-separated,
names only). It can be combined with `parameters` in a single `set` to add some and
remove others; removing a name that isn't set is a no-op. At least one of
`parameters` / `unset-parameters` / `kustomize-images` must be provided.

For Kustomize applications, `kustomize-images` sets image overrides on
`spec.source.kustomize.images`, one per line or comma-separated, each in the same
form as `argocd app set --kustomize-image` (`name=newName:tag`, `name:tag`,
`name@digest`, ...). An override replaces an existing one targeting the same image
(matched the way ArgoCD matches them) rather than duplicating it. Helm parameters
and Kustomize images are independent inputs - use whichever matches the app's
source type; they target the same selected source for multi-source apps.

### Sync - `sync`, `deploy` (sync step), some apply to `rollback`

| input                    | values                             | default | description                                                      |
|--------------------------|------------------------------------|---------|------------------------------------------------------------------|
| `prune`                  | `true` \| `false`                  | `false` | Prune resources removed from Git (also `rollback`)               |
| `force`                  | `true` \| `false`                  | `false` | Force apply during sync                                          |
| `replace`                | `true` \| `false`                  | `false` | `Replace=true` sync option                                       |
| `server-side`            | `true` \| `false`                  | `false` | `ServerSideApply=true` sync option                               |
| `apply-out-of-sync-only` | `true` \| `false`                  | `false` | `ApplyOutOfSyncOnly=true` sync option                            |
| `sync-options`           | `Name=value` per line/comma        |         | Extra sync options (e.g. `CreateNamespace=true`)                 |
| `strategy`               | `apply` \| `hook`                  | `apply` | Sync strategy                                                    |
| `dry-run`                | `true` \| `false`                  | `false` | Don't apply changes; don't wait (also `rollback`)                |
| `revision`               | git revision                       |         | Target revision (`sync`) / revision to roll back to (`rollback`) |
| `resources`              | `[group:]kind:name` per line/comma |         | Limit the sync to these resources (`argocd app sync --resource`) |

### Diff & wait - `diff`, `wait`, `deploy`, `get`, `rollback`

| input                                                      | values                        | default  | description                                                                                                |
|------------------------------------------------------------|-------------------------------|----------|------------------------------------------------------------------------------------------------------------|
| `refresh`                                                  | `false` \| `normal` \| `hard` | `normal` | Refresh the app before diff/wait/get                                                                       |
| `fail-on-diff`                                             | `true` \| `false`             | `false`  | (`diff`) fail the step when a diff is found                                                                |
| `unified-diff`                                             | `true` \| `false`             | `false`  | (`diff`, `deploy`) show field-level `+`/`-` diff values (in the `diff` summary and both commands' job log) |
| `timeout`                                                  | seconds (integer)             | `600`    | Max time to wait for Synced/Healthy                                                                        |
| `wait-for-sync` / `wait-for-health` / `wait-for-operation` | `true` \| `false`             | `true`   | Conditions to wait on                                                                                      |

### Rollback - `rollback`

| input         | values               | description                                            |
|---------------|----------------------|--------------------------------------------------------|
| `rollback-id` | history id (integer) | Explicit deployment id; else `revision`, else previous |

### Deploy (multi-app & failure) - `deploy`

| input           | values                           | default | description                                                                     |
|-----------------|----------------------------------|---------|---------------------------------------------------------------------------------|
| `applications`  | JSON array \| newline/comma list |         | App names; overrides `application`                                              |
| `restart`       | `false` \| kind / comma-list     | `false` | On no diff, restart these workloads                                             |
| `parallel`      | `true` \| `false`                | `true`  | Deploy multiple apps concurrently, max 8 at a time (`false` = one-at-a-time)    |
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

`diff` does **not** reimplement ArgoCD's normalisation engine. It relies on the
server-computed `normalizedLiveState` (live, with `ignoreDifferences` and
normalisers already applied) vs `predictedLiveState` (target) from the
`managed-resources` endpoint, and reports a structural difference between them.
This faithfully reproduces the diff / no-diff _decision_ the pipeline depends on.

## Connection reliability

Every API call has a 30s per-request timeout and is retried with exponential
backoff on transient failures, so a single gateway blip doesn't fail the whole
step. Gateway/overload responses (`429`, `502`, `503`, `504`) are retried for any
method, since they mean the request never reached the ArgoCD backend; timeouts
and network errors are retried only for idempotent calls (the `GET` reads and the
`PUT`/`DELETE` writes), never for a `POST` (e.g. `sync`), which could otherwise be
applied twice. A `Retry-After` header is honoured. Retries are logged, and after
the attempts are exhausted, the underlying error is surfaced as normal. These
limits are internal (no inputs); the `timeout` input is unrelated - it bounds how
long `wait`/`deploy` poll for `Synced`/`Healthy`.

## Development

This repo follows the
[`actions/javascript-action`](https://github.com/actions/javascript-action)
template conventions: ESM source under `src/` (`index.js` -> `main.js`'s
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

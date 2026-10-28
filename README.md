# Dash Status

Live infrastructure board and operator console for DCG-run Dash networks
(testnet, active devnets, limited mainnet observer signals), served at
https://status.testnet.networks.dash.org.

## How it works

```
EC2 (tag DashNetwork=<net>, Name dn-<net>-<role>-<n>)
        │ discovery every 5 min
        ▼
   agent ──SSH every 30 s──▶ every host: agent/probe.py (read-only)
     │                         Docker, Core RPC, Tenderdash RPC/P2P, DAPI gRPC,
     │                         Insight, faucet, wallets, load/mem/disk
     │  writes /srv/dash-status/data/state/<net>.json
     │
     │  reads  /srv/dash-status/data/requests/*.json   (from web)
     │  runs   dashnet managed-import / enroll / plan / upgrade / deploy / doctor
     ▼  writes /srv/dash-status/data/ops/<id>.{json,log}
   web ─── public board, GitHub sign-in, deploy form, review, live logs, settings
```

- **agent** (`STATUS_MODE=agent`) is the only process with credentials: the
  status host's IAM role (`dash-status-server`: EC2 describe, Instance Connect,
  dashnet journal; for console devnets also EC2 launch/teardown of
  dash-network-go-tagged resources, IPAM addresses, and Route 53 A records named
  `insight|quorums|explorer|faucet|dapi|seed-*.<devnet>.networks.dash.org` only, with
  existing testnet/mainnet/Moutai names denied) and its own SSH key. When the key is not yet authorized on a
  newly discovered host it pushes it once through EC2 Instance Connect. Host keys
  are pinned per instance ID. Deployments use the
  [dash-network-go](https://github.com/dashpay/dash-network-go) `dashnet` CLI,
  built into the image from its `main` branch.
- **web** (`STATUS_MODE=web`) has no cloud or SSH access. It evaluates agent
  state (every status carries its reason), serves the UI and SSE updates, writes
  operator settings, and queues operation requests.
- **legacy** (`INVENTORY_PATH` set) is the original single-network Testnet API
  (`/api/nodes`, `/api/events`, …), kept for existing consumers; see
  [API compatibility](deploy/API-COMPATIBILITY.md).

## Operating

Sign in with GitHub. Access is per GitHub account (bound to the numeric user id)
and managed by admins in **Settings → Access**: look up a login, choose a role
and networks, save.

| Role | Can |
| --- | --- |
| viewer | see granted networks in full detail (including private ones) and operation logs |
| operator | deploy, restore and health-gate the granted networks |
| admin | everything, on every network: settings, users, new devnets, Platform resets, deletion |

**Existing managed networks:** *Deploy* chooses nodes, components and
image tags (Docker Hub suggestions, architecture check). The agent imports live
state, enrolls nodes that are not yet enrolled (no restarts) and plans with images
pinned by digest. Nothing changes until the plan is confirmed; execution withdraws
one host at a time behind dashnet health gates, with live progress and log.
Also *Restore stopped*, *Health gate* and *Enroll*.

**New devnet** (admins): name, sizing, component versions and service settings;
the agent runs dash-network-go `resolve` and `provision-plan` (read-only) and shows
the footprint, cost estimate, pinned digests and DNS names for review. After
confirmation: `provision` (BYOIP addresses) → `bootstrap-plan` → `host-trust` →
`bootstrap` → `deployment-plan` → `deploy` (Core, EvoNode registration, quorums,
Platform) → services → `doctor`. Every stage resumes after interruption, with the
exact dashnet binary the plans were made with. The devnet appears on the board
while it is built. Each devnet's wallet host also runs:

- `quorum-list-server` → `https://quorums.<name>.networks.dash.org` (SDKs take the Core devnet name, `<name>`, as `devnetName`; chains older dashnet named `<name>-g1` also get `quorums.<name>-g1`)
- DAPI seeds `seed-1..3.<name>.networks.dash.org` (443 and 1443): Caddy on the wallet host with hostname certificates, spread over every validator's gateway
- Platform Explorer (Postgres, indexer, API, per-devnet frontend) → `https://explorer.<name>…`
- dash-faucet from source, with its own funded wallet topped up every 15 minutes → `https://faucet.<name>…`
- Caddy with Let's Encrypt for all three.

Console devnets can be upgraded (dash-network-go `upgrade-plan`/`upgrade`, Drive,
DAPI, gateway, helper or Tenderdash, one validator at a time), have their services
re-applied from Settings defaults, and be deleted (instances, disks, BYOIP
addresses, DNS; the journal record keeps the name reserved).

**Platform wipe/redeploy** (admins, dashmate devnets including console-created dashnet deployments) follows the
Platform reset rulebook: baseline and private backups on every HPMN and the seed,
image staging, a fresh ChainLock anchor verified everywhere and a canary on a
temporary dashmate home — all before review. After confirmation: wipe Platform on
all HPMNs, reset only the seed's Tenderdash data, apply images/anchor/epoch writing
only `config.json`, rendered Platform files and `dynamic-compose.yml`, start, and
verify READY, images, consensus, epochs (config/env/parsed), DAPI TLS and Core
preservation. Each stage must succeed on every target before the next.

For **console-created dashnet devnets**, wipe/redeploy accepts target Drive, DAPI,
Tenderdash, gateway and helper versions. The helper follows the Drive tag unless
explicitly selected; epoch settings are preserved. Preparation resolves immutable
architecture-specific pins, stages the target release and canaries every validator.
Preparation binds the exact validator instance IDs and addresses to the deployment
plan and uses the target helper in an isolated copy of each dashmate home. Release-required Core RPC access and compatibility migrations are included in the
same review/confirmation. After withdrawing Platform, the controller migrates
affected Core/Tor services together (up to 32 validators per batch), preserving Core image, chain, data
mounts, credentials and identities. Mining pauses only in a quiet DKG window and
stays paused across restart and fleet READY/sync checks, then resumes before final quorum-link verification so block production can drive convergence; an independent 15-minute
lease also resumes it after controller loss. Core migration is bounded to ten
minutes per host/phase; the lease renews before each phase. Original backups and resumable per-host receipts are retained. Parallel mode is reset-only (all Platform services must already be withdrawn); existing reviewed rolling plans keep their original order. Wallet Core is never restarted.
Confirmation removes only the owned Drive/Tenderdash chain-data volumes and
restarts Platform through dashnet's Compose project. Core data, Tor settings, registrations,
node identities, TLS certificates, wallet/miner/web hosts and log volumes are
preserved. The on-host Platform anchor/identity metadata and the console's Connect
files follow the verified reset; historical creation plans are not rewritten.
Native execution claims dashnet’s authoritative journal with an exact revision check
before wiping. Failures keep the non-expiring claim for the same operation’s Resume.
After verification, host receipts, runtime image pins, the genesis anchor and the
console’s current version choices are committed; future Deploy uses that state.
No reset is auto-confirmed. Failed stages retain backups and per-host receipts
for resume. A full destructive end-to-end reset is not part of UI smoke tests.

**Settings** (admins): probe/discovery cadence, thresholds, access, new devnet
defaults (placement, sizing, versions, services) and per network: EC2 tag, chain,
visibility, deployability, balance visibility, observation window, timeout and
checked endpoints (HTTP or DAPI gRPC-Web). Applied on the agent's next cycle;
AWS account/region changes take effect after an agent restart.

**Mainnet** is a deliberately limited observer board, not a mainnet-support-fleet monitor. A separately managed Evolution fullnode observer reports Core ChainLocks and stall state, Platform block progress and stall state, the public quorum-list-server, and the count of large PoSe bans. The `mainnet-support` EC2 fleet is not discovered or probed by this application, and no Mainnet operations are exposed. The observer report is token-scoped and contains only public chain/service facts. The web container reads `MAINNET_REPORT_TOKEN` from `/etc/dash-status/mainnet.env`; the observer host uses the same secret in `/etc/dash-mainnet-observer/env`. Install `deploy/dash-mainnet-observer.service` only on the dedicated observer/fullnode host.

## Infrastructure pages

Visible to any account with access (any role).

**CI** (`/ci`) covers the self-hosted GitHub Actions runners. Each runner host
runs [ci/reporter/dash-ci-reporter.py](ci/reporter/dash-ci-reporter.py) from
cron every minute. It uses Python 3.9+ and the standard library only, and is
read-only on the host. It POSTs to `/api/ci/report` with the host's own bearer
token. Each report carries:

- host load, memory, disk and Docker usage;
- per runner (native directory or Docker container, on the host or reached over
  SSH, e.g. in a VM): registration, runner version, listener/worker state, the
  running job and the size of `_diag`;
- every finished job, parsed from the listener log (`Runner_*.log`), with
  repository, workflow, run and branch taken from the job's worker log.

Undelivered jobs are kept and retried. A new host needs an admin to issue a token
on the CI page, then:

```sh
DASH_CI_TOKEN=dcr_... DASH_CI_RUNNERS='[{"dir":"'$HOME'/actions-runner"}]' sh ci/reporter/install.sh
# a runner in Docker: DASH_CI_RUNNERS='[{"container":"dash-ci-runner"}]'
```

A runner in a VM (or on any machine the host can SSH to) is listed with `ssh`,
the arguments that reach it: `{"ssh": ["-i", "/path/key", "user@localhost"],
"container": "name"}`, or with `"dir"` for a runner installed there. Its key's
`authorized_keys` line should force
[ci/reporter/dash-ci-gate.py](ci/reporter/dash-ci-gate.py), which runs only the
reporter's read-only commands on that runner's `.runner` and `_diag` (not its
credentials), through a prefix such as the VM's exec command:

```text
restrict,from="127.0.0.1,::1",command="/usr/bin/python3 /path/dash-ci-gate.py --dir /runner --container name -- /path/vm-exec" ssh-ed25519 AAAA...
```

The web adds queue times (GitHub job `created_at` → `started_at`) and the jobs
currently waiting for a self-hosted runner. It gets these from the GitHub API for
public repositories, authenticated with the OAuth app's client credentials (5000
requests/h). Data is kept in `data/ci/` for 30 days.

**Actions queue** (`/ci/queue`) lists every workflow job in the org that is waiting
for a runner or running, on GitHub-hosted and self-hosted runners alike. Jobs held
before they ask for a runner (an environment approval, or a concurrency group) are
counted and listed apart, since they say nothing about runner capacity. Runner wait
is measured from when a job was seen queued after any such hold. A job first seen
already running is timed from its creation (a hold the server never saw would count
as wait), unless that exceeds 24 h; a job seen held and then running is left out. Jobs are grouped by
their `runs-on` labels, with the wait so far, the 24 h median and p90 wait, and when
a runner last took that label set. A job with no update for 2 hours (no webhook
event and no sweep that could read it) is marked unverified, and dropped only once
older than GitHub allows in its state: queued 24 h, running 5 days, held 30 days. Runs queued for over 24 hours,
which GitHub will never start, are listed separately so they can be cancelled. Signed out,
the page shows public repositories only, without branches, links or runner names.

- An org webhook keeps the page live. In the org settings, under Webhooks, set the
  payload URL to `https://status.testnet.networks.dash.org/api/ci/github-webhook`,
  the content type to `application/json`, and a random secret. Select only the
  **Workflow jobs** event. Put the same secret in `/etc/dash-status/oauth.env` as
  `CI_WEBHOOK_SECRET=…` and redeploy. Without it, the endpoint answers 404.
- Every 15 minutes, a sweep of the REST API covers repositories pushed in the last
  60 days. It adds jobs queued before the webhook existed, drops jobs whose
  completion was never delivered, and finds stuck runs. It uses the OAuth app
  credentials, which cover public repositories only. With
  `CI_QUEUE_GITHUB_TOKEN=…` (a fine-grained token with read-only *Actions* and
  *Metadata* on all dashpay repositories), it covers private ones too. Without
  the token, private repositories rely on the webhook alone. The sweep stops
  while fewer than 1500 requests remain this hour, leaving the rest for the
  runner page.
- State is kept in `data/ci/org-queue.json`: active jobs, finished jobs for 24 h,
  and label sets served for 30 days. Set `CI_QUEUE_ORG` to change the
  organisation (default `dashpay`).

**AWS** (`/aws`) is an account-wide, read-only inventory collected by the agent
through the inline policy [status-inventory](deploy/iam/status-inventory.json)
on `dash-status-server`:

- Every 10 minutes, across all enabled regions: instances, EBS volumes, Elastic
  IPs, NAT gateways, load balancers, Lambda, DynamoDB, CloudFront and S3.
- Every 6 hours: ECR repository sizes, snapshots and instance-type facts.
- Every 12 hours: Cost Explorer month-to-date by service, daily cost and the
  month-end forecast. Each request is billed at $0.01.

The page lists idle resources that still bill: unattached volumes, unassociated
EIPs, stopped instances' EBS, and unbounded ECR repositories. Data is stored in
`data/aws/inventory.json`.

## Develop

```sh
npm ci --include=dev
npm test && npm run lint && npm run build
npx playwright install chromium
node scripts/browser-check.mjs        # fixture state, public + operator flow, CI/AWS pages, screenshots in artifacts/
STATUS_MODE=web STATUS_DATA_DIR=./data PUBLIC_ORIGIN=http://localhost:3001 npm start
```

## Deploy

On the status host (images are built there, Go and Node stages included):

```sh
sudo /opt/dash-status/src/deploy/deploy.sh            # origin/master
sudo /opt/dash-status/src/deploy/deploy.sh <git-ref>  # any ref
```

The script builds `dash-status:<rev>`, retags `dash-status:current`, restarts the
`web` and `agent` services from [deploy/compose.yml](deploy/compose.yml) and rolls
back if the web health check fails. nginx proxies `/` and `/api/` to
`127.0.0.1:3006`; the legacy routes in
[nginx-legacy-api.conf](deploy/nginx-legacy-api.conf) go to the legacy container
on `127.0.0.1:3002`. Operation history and agent state survive redeploys; an
agent restart during a running operation marks it interrupted (resumable).

### Separate Mainnet observer

Mainnet is report-only and never an EC2/support-fleet target. On the authorized
fullnode host, install `deploy/mainnet-observer.py` under `/opt/dash-mainnet-observer/`
and the matching service/timer under `/etc/systemd/system/`. Configure root-only
`/etc/dash-mainnet-observer/env` with `MAINNET_REPORT_TOKEN`, `STATUS_URL` and
`OBSERVER_COMPOSE_PROJECT` (the exact local fullnode Compose project). The web
container receives the matching credential via `/etc/dash-status/mainnet.env`.
Enable `dash-mainnet-observer.timer`; the bounded oneshot runs every minute,
never concurrently, and retains independent progress clocks in its StateDirectory.
The root service needs the host Docker socket to execute only read-only RPCs in
that project; it has no AWS/SSH credentials. Do not give the web process this socket.

Missing reports expire after three minutes. Core and Platform stalls require
30 minutes without progress in a continuously sampled, synced observer; initial
sync and collection gaps remain unknown. PoSe totals come from Core's whole-network
masternode list, not the quorum server's subset. A large-ban alert defaults to
20 newly banned masternodes over an hour; historical bans remain visible without
triggering this alert. The quorum-list check requires both nonempty masternode and
quorum JSON responses. No payouts, signing operations or fleet mutations occur.

## Functional monitoring evidence

The network page and `summary.monitoring` report eight independent areas: quorum/ChainLocks,
wallet/faucet outcomes, Explorer queries, DAPI/Drive queries, Platform consensus, Core behavior,
role services and upgrade convergence. Probes are read-only: they never submit payments or mine blocks.

- DAPI `getEpochsInfo` exercises Drive. Insight queries a recent block, its transaction and an address.
- Last-day faucet-wallet sends and legacy faucet records are checked for confirmations/InstantLocks.
  No recent traffic means **unproven**, not a successful synthetic payout. Legacy queue checks are
  labelled separately from the public faucet's `/api/status`; no recipient, user IP, promo code or txid is exported.
- DKG phases/aborts, threshold commit signatures, round/proposer, set membership and voting power are facts,
  not claims that this fleet is the entire network or that a rotating nonmember is unhealthy.
- Miner service/container, CoinJoin state, Grafana DB, Prometheus targets, Elasticsearch and Kibana
  health are observed where available. Protected endpoints and unprobed VPNs stay explicitly unobserved.
- Bounded one-hour progress history survives agent restarts. Failed/gapped samples, replacement instance
  identities and initial sync cannot establish a chain stall. Payment and restart deltas are per sample.
- Confirmed, actually executing operations establish per-node/component image targets. Pending review
  never changes intent; active rollout, awaiting a fresh post-operation sample, drift and absent targets
  are separate. Mutable tags are compared as tags; digest evidence is used when the reviewed target pins a digest.

New functional failures can expose old service problems hidden by homepage-only checks. Inspect the
individual source and timestamps before changing the monitored service.

## Machine-readable issues and incident response

`GET /api/issues` aggregates network, CI and AWS issues, with a redacted public
view and a scoped authenticated detail view. Optional durable delivery to an
OpenClaw receiver uses tailnet-only HTTPS, HMAC authentication, deduplication and
a serialized, owner-authorized repair worker. See [deployment, behavior and
coverage limits](deploy/INCIDENTS.md). Retired Moutai is no longer a default network.

### Operation-aware remediation maintenance

Confirmed/running mutating console operations automatically hold remediation for
their managed Testnet/devnet network. Preparation/review and read-only doctor
requests do not. Raw health stays visible; other networks, Mainnet, CI and AWS
continue through the normal incident path. The Remediation page lists networks
in maintenance even when no incident exists yet.

The producer suppresses new network events and holds already-queued outbox events
without changing their immutable bytes. The broker refreshes the private issue
snapshot immediately before dispatch and rejects suppressed/maintenance events,
including events queued before the next producer cycle. The API reads operation
records directly, not the collector's delayed/missing native journal field.
Existing repair sessions are not forcibly killed; their usual live-operation
ownership checks remain mandatory. A narrow operation-start/admission race is
not a distributed lock.

Terminal operations release this hold; healthy recovery requires fresh
post-maintenance measurements. Abandoned operation records expire after 35 minutes
without a saved progress update, with an absolute 24-hour cap, so they cannot
silence monitoring indefinitely. Manual maintenance/journal gates remain separate.

Deployment requires both the status web/incident-worker changes and the broker
refresh check. Merging this source does not deploy either component.

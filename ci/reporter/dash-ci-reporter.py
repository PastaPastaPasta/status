#!/usr/bin/env python3
"""dash-ci-reporter: push a self-hosted GitHub Actions runner host's health and
job history to the Dash status board (cron, every minute).

Read-only on the host. Python 3.9+ standard library only (macOS ships 3.9).

  ~/.dash-ci-reporter/config.json   {"url": ".../api/ci/report", "token": "...",
                                     "runners": [{"dir": "/path/actions-runner"},
                                                 {"container": "name", "dir": "/runner"},
                                                 {"ssh": ["-i", "/path/key", "user@vm-host"],
                                                  "container": "name"}],
                                     "pools": ["/run/dash-ci-pool"]}
  ~/.dash-ci-reporter/state.json    log offsets, jobs not yet delivered

"ssh" reaches a runner on another machine, a VM say (with "dir", or "container"
for one in Docker there): ssh arguments ending with the destination. Its commands
go as one shell-quoted SSH command, to a Linux machine or container (GNU
stat/du). Restrict the key on the far end with dash-ci-gate.py, which runs only
these commands and only on .runner and _diag.

"pools" are dash-ci-pool hosts (single-use runners, one job each): pool state
comes from its status.json and finished jobs from its jobs.jsonl, which the
controller writes from each runner's logs before destroying it.

Jobs of long-lived runners come from the runner listener log (_diag/Runner_*.log:
"Running job" and "Job ... completed with result"); repository, workflow and run
come from the job's worker log (_diag/Worker_*.log), which the runner writes as the job starts.
"""
import bisect
import datetime
import fcntl
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

REPORTER_VERSION = '3'
BACKFILL_DAYS = 14
MAX_PENDING = 5000
BATCH = 250
WORKER_HEAD = 128 * 1024
POOL_SEEN = 5000
POOL_LINES = POOL_SEEN // 2  # newest ledger lines read: fewer than remembered keys, so none is sent twice
POOL_STALE = 120
JOB_KEYS = ('name', 'start', 'end', 'result', 'repo', 'runId', 'attempt', 'workflow', 'event', 'headRef', 'ref', 'visibility')
EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', os.path.expanduser('~/.orbstack/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin']

LOG_NAME = re.compile(r'^(Runner|Worker)_(\d{8}-\d{6})-utc\.log$')
RUNNING = re.compile(r'WRITE LINE: (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)Z: Running job: (.+)$')
COMPLETED = re.compile(r'WRITE LINE: (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)Z: Job (.+) completed with result: (\w+)$')
VERSION = re.compile(r"INFO Listener\] Version: ([\d.]+)|Current runner version: '([\d.]+)'|runnerVersion=([\d.]+)")
META_KEYS = {'repository': 'repo', 'run_id': 'runId', 'run_attempt': 'attempt', 'workflow': 'workflow',
             'event_name': 'event', 'head_ref': 'headRef', 'ref': 'ref', 'repository_visibility': 'visibility'}
META = re.compile(r'"k":\s*"(' + '|'.join(META_KEYS) + r')",\s*"v":\s*"((?:[^"\\]|\\.){0,300})"')
DISPLAY = re.compile(r'"jobDisplayName":\s*"((?:[^"\\]|\\.){0,500})"')


def iso(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def describe(e, limit=300):
    return ('%s: %s' % (type(e).__name__, e))[:limit]


def parse_ts(text):
    return datetime.datetime.strptime(text, '%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone.utc).timestamp()


def name_ts(name):
    m = LOG_NAME.match(name)
    if not m:
        return None
    return datetime.datetime.strptime(m.group(2), '%Y%m%d-%H%M%S').replace(tzinfo=datetime.timezone.utc).timestamp()


def tool(name):
    return shutil.which(name, path=os.pathsep.join([os.environ.get('PATH', '')] + EXTRA_PATH))


class Exited(RuntimeError):
    def __init__(self, name, code):
        super().__init__('%s exited %d' % (name, code))
        self.code = code


def run(args, timeout=30):
    p = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    if p.returncode != 0:
        raise Exited(os.path.basename(args[0]), p.returncode)
    return p.stdout


def unescape(v):
    try:
        return json.loads('"' + v + '"')
    except ValueError:
        return v


class Native:
    """A runner installed in a directory on this host."""
    kind = 'native'

    def __init__(self, directory):
        self.dir = directory.rstrip('/')
        self.container = None

    def path(self, rel):
        return os.path.join(self.dir, rel)

    def listdir(self, rel):
        return os.listdir(self.path(rel))

    def size(self, rel):
        return os.path.getsize(self.path(rel))

    def read(self, rel, offset=0, limit=-1):
        with open(self.path(rel), 'rb') as f:
            f.seek(offset)
            return f.read(limit)

    def exists(self):
        return os.path.isfile(self.path('.runner'))

    def processes(self):
        return self.listener_worker(run(['ps', '-axo', 'command'] if sys.platform == 'darwin' else ['ps', '-eo', 'args']))

    def listener_worker(self, ps):
        mine = [l for l in ps.decode(errors='replace').splitlines() if self.dir + '/bin/Runner.' in l]
        return any('Runner.Listener' in l for l in mine), any('Runner.Worker' in l for l in mine)

    def dir_bytes(self, rel):
        total = files = 0
        with os.scandir(self.path(rel)) as it:
            for e in it:
                try:
                    if e.is_file(follow_symlinks=False):
                        total += e.stat(follow_symlinks=False).st_size
                        files += 1
                except OSError:
                    pass
        return total, files

    def container_state(self):
        return None


class Remote(Native):
    """A runner reached through commands: inside a container (its install directory
    is inside, e.g. /runner), on another machine over SSH, or in a container there."""

    def __init__(self, directory, container=None, ssh=None):
        super().__init__(directory)
        self.container = container
        self.ssh = ssh
        self.kind = 'docker' if container else 'native'
        self.docker = 'docker' if ssh else (tool('docker') or 'docker')

    def run(self, args, timeout=30):
        """`args` on the runner's machine. SSH sends one command line, which the far
        end's shell (or dash-ci-gate.py) splits again, so it goes shell-quoted."""
        if self.ssh:
            return run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'] + self.ssh + [shlex.join(args)], timeout=timeout)
        return run(args, timeout=timeout)

    def exec(self, *args, timeout=30):
        return self.run(([self.docker, 'exec', self.container] if self.container else []) + list(args), timeout=timeout)

    def listdir(self, rel):
        return [l for l in self.exec('ls', '-1A', self.path(rel)).decode(errors='replace').splitlines() if l]

    def size(self, rel):
        return int(self.exec('stat', '-c', '%s', self.path(rel)).strip())

    def read(self, rel, offset=0, limit=-1):
        # Regular files only: a FIFO or symlink planted in _diag must not block or redirect the read.
        script = 'test -f "$1" && test ! -L "$1" && tail -c +%d "$1"' % (offset + 1) + ('' if limit < 0 else ' | head -c %d' % limit)
        return self.exec('sh', '-c', script, 'sh', self.path(rel), timeout=60)

    def exists(self):
        try:
            self.exec('test', '-f', self.path('.runner'))
            return True
        except Exited as e:
            if e.code == 1:  # test's "no"; anything else (ssh, the VM, the gate) is reported as is
                return False
            raise

    def processes(self):
        if not self.container:  # only this runner's command lines leave the machine
            return self.listener_worker(self.run(['sh', '-c', 'ps -A -o command | grep -F -- "$1/bin/Runner." || true', 'sh', self.dir]))
        out = self.run([self.docker, 'top', self.container, '-eo', 'pid,args']).decode(errors='replace')
        return 'Runner.Listener' in out, 'Runner.Worker' in out

    def dir_bytes(self, rel):
        total = int(self.exec('du', '-sb', self.path(rel), timeout=120).split()[0])
        files = int(self.exec('sh', '-c', 'ls -1A "$1" | wc -l', 'sh', self.path(rel)).strip())
        return total, files

    def container_state(self):
        raw = self.run([self.docker, 'inspect', '-f', '{{json .State}}|{{.RestartCount}}|{{.Config.Image}}', self.container]).decode().strip()
        state, restarts, image = raw.rsplit('|', 2)
        s = json.loads(state)
        return dict(status=s.get('Status'), startedAt=s.get('StartedAt'), restarts=int(restarts), image=image[:200])


def runner_identity(r):
    raw = r.read('.runner').decode('utf-8-sig', errors='replace')
    v = json.loads(raw)
    return dict(name=v.get('agentName'), pool=v.get('poolName'), org=(v.get('gitHubUrl') or '').rstrip('/').rsplit('/', 1)[-1])


def worker_index(names, since):
    """(start, name) of worker logs since `since`, sorted. _diag can hold 100k+ files."""
    day = datetime.datetime.fromtimestamp(since, datetime.timezone.utc).strftime('Worker_%Y%m%d')
    return sorted((name_ts(n), n) for n in names if n.startswith('Worker_') and n[:15] >= day and name_ts(n) is not None)


def worker_meta(r, name, start, workers):
    """Repository/workflow/run of the job that started at `start`, from its worker log."""
    i = bisect.bisect_left(workers, (start - 5, ''))
    candidates = [w for w in workers[i:i + 20] if w[0] <= start + 120]
    if not candidates:
        return {}
    best = min(candidates, key=lambda w: abs(w[0] - start))
    head = r.read('_diag/' + best[1], 0, WORKER_HEAD).decode('utf-8', errors='replace')
    d = DISPLAY.search(head)
    if d and unescape(d.group(1)) != name:
        return {}
    meta = {}
    for m in META.finditer(head):
        key = META_KEYS[m.group(1)]
        if key not in meta:
            meta[key] = unescape(m.group(2))
    if not meta.get('ref', 'refs/').startswith('refs/'):
        del meta['ref']
    for k in ('runId', 'attempt'):
        if k in meta:
            try:
                meta[k] = int(meta[k])
            except ValueError:
                del meta[k]
    return meta


def scan_jobs(r, key, st, now, pending):
    """Advance through new listener-log lines; completed jobs go to `pending`.

    Listener logs are append-only. The runner starts a new page every 8 MB and a
    new log with each listener process, so only the newest two keep offsets and
    older ones are behind the `after` watermark (a crash-looping runner can
    leave 100k+ of them). A job ends with its "completed" line; a listener
    startup banner or the next "Running job" (one job at a time) abandons it."""
    names = r.listdir('_diag')
    cutoff = datetime.datetime.fromtimestamp(now - BACKFILL_DAYS * 86400, datetime.timezone.utc).strftime('Runner_%Y%m%d')
    after = st.get('after', '')
    found = sorted(n for n in names if n.startswith('Runner_') and n > after and LOG_NAME.match(n))
    newest = set(found[-2:])  # a long-lived listener's log may predate the backfill window
    logs = [n for n in found if n >= cutoff or n in newest]
    offsets = {n: o for n, o in st.get('offsets', {}).items() if n in logs}
    open_jobs = st.setdefault('open', [])
    cache = {}

    def index():
        if 'workers' not in cache:
            cache['workers'] = worker_index(names, now - BACKFILL_DAYS * 86400 - 86400)
        return cache['workers']

    def abandon():
        for j in list(open_jobs):
            open_jobs.remove(j)
            j.update(end=None, result='Abandoned')
            pending.append(j)

    for n in logs:
        offset = offsets.get(n, 0)
        size = r.size('_diag/' + n)
        if size < offset:
            offset = 0
        if size == offset:
            offsets[n] = offset
            continue
        data = r.read('_diag/' + n, offset, min(size - offset, 32 * 1024 * 1024))
        end = data.rfind(b'\n')
        if end < 0:
            continue
        for line in data[:end].decode('utf-8', errors='replace').splitlines():
            try:
                if 'WRITE LINE: ' not in line:
                    if 'ersion' in line:
                        m = VERSION.search(line)
                        if m:
                            st['version'] = next(g for g in m.groups() if g)
                            if m.group(1):  # "Listener] Version:" opens a new listener process
                                abandon()
                    continue
                m = RUNNING.search(line)
                if m:
                    abandon()
                    start = parse_ts(m.group(1))
                    job = dict(runner=key, name=m.group(2).strip()[:300], start=iso(start), end=None, result=None, log=n)
                    add_meta(r, job, index())
                    open_jobs.append(job)
                    continue
                m = COMPLETED.search(line)
                if m:
                    name = m.group(2).strip()[:300]
                    for j in reversed(open_jobs):
                        if j['name'] == name:
                            j.update(end=iso(parse_ts(m.group(1))), result=m.group(3))
                            open_jobs.remove(j)
                            pending.append(j)
                            break
                elif 'Current runner version' in line:
                    m = VERSION.search(line)
                    if m:
                        st['version'] = next(g for g in m.groups() if g)
            except ValueError:
                continue  # a corrupt timestamp: skip the line, keep advancing
        offsets[n] = offset + end + 1
    # The worker log appears a second or two after "Running job": a job read in
    # that gap gets its repository from a later listing.
    for j in open_jobs + [j for j in pending if j.get('runner') == key]:
        if 'repo' not in j and j.get('metaTries', 0) < 3:
            j['metaTries'] = j.get('metaTries', 0) + 1
            add_meta(r, j, index())
    if len(found) > 2:
        st['after'] = found[-3]
    st['offsets'] = {n: offsets[n] for n in logs[-2:] if n in offsets}


def add_meta(r, job, workers):
    try:
        job.update(worker_meta(r, job['name'], parse_ts(job['start'].replace('T', ' ').rstrip('Z')), workers))
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired):
        pass


def collect_pool(directory, state, pending, now):
    """Pools of a dash-ci-pool controller; its newly finished jobs go to `pending`."""
    pools, error = [], None
    try:
        with open(os.path.join(directory, 'status.json')) as f:
            status = json.load(f)
        age = now - status['time']
        stale = age > POOL_STALE  # a stopped controller leaves its last status behind
        instances = [] if stale else status.get('instances', [])
        for name, p in sorted(status.get('pools', {}).items()):
            counts = dict(idle=0, busy=0, starting=0) if stale else {k: p.get(k) for k in ('idle', 'busy', 'starting')}
            pools.append(dict(controller=status.get('host'), name=name, backend=p.get('backend'), labels=p.get('labels', []), size=p.get('size'),
                              draining=status.get('draining') is True, at=iso(status['time']),
                              error='dash-ci-pool has not updated its status for %d min' % (age // 60) if stale else None,
                              instances=[dict(name=i['name'], state=i['state'], since=iso(i['since'])) for i in instances if i.get('pool') == name][:64],
                              **counts))
    except Exception as e:  # jobs are still delivered
        error = describe(e)
    seen = state.setdefault('poolSeen', [])
    known = set(seen)
    try:
        with open(os.path.join(directory, 'jobs.jsonl')) as f:
            lines = f.read().splitlines()[-POOL_LINES:]
    except FileNotFoundError:
        lines = []
    except Exception as e:
        lines, error = [], error or describe(e)
    for line in lines:
        try:
            j = json.loads(line)
        except ValueError:
            continue
        runner = j.get('runner') if isinstance(j, dict) else None
        key = '%s|%s' % (runner, j.get('start')) if isinstance(runner, str) else None
        if not key or key in known:
            continue
        known.add(key)
        seen.append(key)
        job = {k: j[k] for k in JOB_KEYS if j.get(k) is not None}
        pending.append(dict(job, runner=runner, runnerName=runner, pool=j.get('pool')))
    del seen[:-POOL_SEEN]
    if error and not pools:
        raise RuntimeError(error)
    for p in pools:
        p['error'] = p['error'] or error
    return pools


def host_metrics():
    h = dict(hostname=socket.gethostname(), arch=platform.machine(), cpus=os.cpu_count(), load=[round(x, 2) for x in os.getloadavg()])
    if sys.platform == 'darwin':
        h['os'] = 'macOS ' + run(['sw_vers', '-productVersion']).decode().strip()
        h['memTotal'] = int(run(['sysctl', '-n', 'hw.memsize']).strip())
        vm = run(['vm_stat']).decode()
        page = int(re.search(r'page size of (\d+)', vm).group(1))
        pages = {k.strip(): int(v.strip().rstrip('.')) for k, v in re.findall(r'^([^:]+):\s+(\d+)\.?$', vm, re.M)}
        h['memUsed'] = page * (pages.get('Pages active', 0) + pages.get('Pages wired down', 0) + pages.get('Pages occupied by compressor', 0))
        boot = re.search(r'sec = (\d+)', run(['sysctl', '-n', 'kern.boottime']).decode())
        h['uptimeSec'] = int(time.time() - int(boot.group(1))) if boot else None
        roots = ['/System/Volumes/Data']
    else:
        pretty = ''
        try:
            with open('/etc/os-release') as f:
                pretty = dict(l.rstrip('\n').split('=', 1) for l in f if '=' in l).get('PRETTY_NAME', '').strip('"')
        except OSError:
            pass
        h['os'] = pretty or platform.platform()
        with open('/proc/meminfo') as f:
            mem = {l.split(':')[0]: int(l.split()[1]) * 1024 for l in f if l.split()[1:2]}
        h['memTotal'] = mem.get('MemTotal')
        h['memUsed'] = mem.get('MemTotal', 0) - mem.get('MemAvailable', 0)
        with open('/proc/uptime') as f:
            h['uptimeSec'] = int(float(f.read().split()[0]))
        roots = ['/']
    disks, seen = [], set()
    for p in roots + [os.path.expanduser('~')]:
        try:
            s, dev = os.statvfs(p), os.stat(p).st_dev
        except OSError:
            continue
        if dev in seen:
            continue
        seen.add(dev)
        disks.append(dict(path=p, total=s.f_blocks * s.f_frsize, free=s.f_bavail * s.f_frsize))
    h['disks'] = disks
    return h


SIZE = re.compile(r'^([\d.]+)\s*([kKMGTP]?B)')


def to_bytes(text):
    m = SIZE.match(text or '')
    if not m:
        return None
    return int(float(m.group(1)) * {'B': 1, 'kB': 1e3, 'KB': 1e3, 'MB': 1e6, 'GB': 1e9, 'TB': 1e12, 'PB': 1e15}[m.group(2)])


def docker_usage():
    docker = tool('docker')
    if not docker:
        return None
    out = run([docker, 'system', 'df', '--format', '{{json .}}'], timeout=120).decode()
    usage = {}
    for line in out.splitlines():
        v = json.loads(line)
        key = {'Images': 'images', 'Containers': 'containers', 'Local Volumes': 'volumes', 'Build Cache': 'buildCache'}.get(v.get('Type'))
        if key:
            usage[key] = dict(count=int(v.get('TotalCount') or 0), bytes=to_bytes(v.get('Size')), reclaimable=to_bytes(v.get('Reclaimable')))
    return usage


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, value):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(value, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def collect(config, state, now):
    pending = state.setdefault('pending', [])
    slow = state.setdefault('slow', {})
    runners = []
    for spec in config.get('runners', []):
        container, ssh = spec.get('container'), spec.get('ssh')
        directory = spec.get('dir', '/runner') if container else spec['dir']
        r = Remote(directory, container, ssh) if container or ssh else Native(directory)
        key = container or r.dir
        if ssh:  # runners in VMs from one image share their dir or container name
            key = '%s:%s' % (ssh[-1], key)
        st = state.setdefault('runners', {}).setdefault(key, {})
        info = dict(key=key, kind=r.kind, container=r.container, dir=r.dir)
        try:
            if r.container:
                info['containerState'] = r.container_state()
            if not r.exists():
                raise RuntimeError('no runner registration (.runner) in ' + r.dir)
            info.update(runner_identity(r))
            for j in pending + st.get('open', []):
                if j.get('runner') == key:
                    j['runnerName'] = info['name']
            info['listening'], info['busy'] = r.processes()
            scan_jobs(r, key, st, now, pending)
            for j in pending:
                if j.get('runner') == key:
                    j['runnerName'] = info['name']
            info['version'] = st.get('version')
            current = st.get('open', [])[-1:] if info['busy'] else []
            info['job'] = {k: v for k, v in current[0].items() if k != 'log'} if current else None
            if now - slow.get('diagAt', {}).get(key, 0) > 3600:
                total, files = r.dir_bytes('_diag')
                slow.setdefault('diag', {})[key] = dict(bytes=total, files=files)
                slow.setdefault('diagAt', {})[key] = now
            info['diag'] = slow.get('diag', {}).get(key)
        except Exception as e:  # report what is wrong instead of going silent
            info['error'] = describe(e)
        runners.append(info)
    pools = []
    for directory in config.get('pools', []):
        try:
            pools += collect_pool(directory, state, pending, now)
        except Exception as e:
            pools.append(dict(name=os.path.basename(directory.rstrip('/')) or 'dash-ci-pool', error=describe(e)))
    del pending[:-MAX_PENDING]
    try:
        host = host_metrics()
    except Exception as e:  # metrics never block job delivery
        host = dict(hostname=socket.gethostname(), error=describe(e, 200))
    if now - slow.get('dockerAt', 0) > 600:
        try:
            slow['docker'] = docker_usage()
        except Exception as e:
            slow['docker'] = dict(error=str(e)[:200])
        slow['dockerAt'] = now
    host['docker'] = slow.get('docker')
    return dict(v=1, reporter=REPORTER_VERSION, python=platform.python_version(), at=iso(now), host=host, runners=runners, pools=pools)


def post(config, payload):
    body = json.dumps(payload).encode()
    q = urllib.request.Request(config['url'], data=body, method='POST', headers={
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config['token'], 'User-Agent': 'dash-ci-reporter/' + REPORTER_VERSION})
    with urllib.request.urlopen(q, timeout=30) as response:
        return json.loads(response.read(1024 * 1024) or b'{}')


def main(argv):
    # cron's PATH is minimal (macOS: /usr/bin:/bin, without sysctl in /usr/sbin).
    os.environ['PATH'] = os.pathsep.join([os.environ.get('PATH', '')] + EXTRA_PATH)
    home = os.environ.get('DASH_CI_REPORTER_HOME') or os.path.expanduser('~/.dash-ci-reporter')
    config = load(os.path.join(home, 'config.json'), None)
    if not config:
        print('missing ' + os.path.join(home, 'config.json'), file=sys.stderr)
        return 2
    with open(os.path.join(home, 'lock'), 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return 0  # the previous run is still going
        state_path = os.path.join(home, 'state.json')
        state = load(state_path, {})
        payload = collect(config, state, time.time())
        # A job that just started may still get its repository from a later
        # listing (its worker log appears after "Running job"); give it a run.
        settled = lambda j: 'repo' in j or 'pool' in j or j.get('metaTries', 0) >= 2 or time.time() - parse_ts(j['start'][:19].replace('T', ' ')) > 3600
        ready = [j for j in state['pending'] if settled(j)][:BATCH]
        batch = [{k: v for k, v in j.items() if k not in ('log', 'metaTries')} for j in ready]
        payload['jobs'] = batch
        if '--print' in argv:  # dry run: show the report, keep the state as it was
            print(json.dumps(payload, indent=1))
            return 0
        try:
            post(config, payload)
            sent = set(map(id, ready))
            state['pending'] = [j for j in state['pending'] if id(j) not in sent]
            state['lastPost'] = dict(at=payload['at'], ok=True)
        except (urllib.error.URLError, OSError, ValueError) as e:
            state['lastPost'] = dict(at=payload['at'], ok=False, error=str(e)[:200])
        save(state_path, state)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

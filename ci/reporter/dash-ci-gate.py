#!/usr/bin/env python3
"""dash-ci-gate: the forced command for dash-ci-reporter's SSH key on the machine
that reaches a runner (a VM's host account, say). It runs only the commands the
reporter sends ("ssh" runners in its config), only on that runner's .runner and
_diag (never its credentials), through an optional prefix that reaches the
runner. Python 3.9+ standard library only.

  authorized_keys of the account that runs the VM:
    restrict,from="127.0.0.1,::1",command="/usr/bin/python3 /path/dash-ci-gate.py --dir /runner --container NAME -- /path/vm-exec" ssh-ed25519 AAAA...

The reporter's command arrives in SSH_ORIGINAL_COMMAND, shell-quoted; refused
commands exit 126 without running anything.
"""
import argparse
import os
import re
import shlex
import sys

NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]*$')
TAIL = re.compile(r'^tail -c \+[0-9]+ "\$1"( \| head -c [0-9]+)?$')
COUNT = 'ls -1A "$1" | wc -l'
INSPECT = '{{json .State}}|{{.RestartCount}}|{{.Config.Image}}'


def allowed(argv, directory, container):
    diag = directory + '/_diag'

    def path(p):  # .runner, _diag, or a file directly in _diag
        return p in (directory + '/.runner', diag) or (p.startswith(diag + '/') and NAME.match(p[len(diag) + 1:]) is not None)

    def command(a):
        if len(a) == 3 and a[:2] in (['ls', '-1A'], ['test', '-f'], ['du', '-sb']) or len(a) == 4 and a[:3] == ['stat', '-c', '%s']:
            return path(a[-1])
        if len(a) == 5 and a[:2] == ['sh', '-c'] and a[3] == 'sh':
            return (a[2] == COUNT or TAIL.match(a[2]) is not None) and path(a[4])
        return False

    if not container:
        return argv == ['ps', '-A', '-o', 'command'] or command(argv)
    return (argv in (['docker', 'top', container, '-eo', 'pid,args'], ['docker', 'inspect', '-f', INSPECT, container])
            or argv[:3] == ['docker', 'exec', container] and command(argv[3:]))


def main(argv):
    split = argv.index('--') if '--' in argv else len(argv)
    parser = argparse.ArgumentParser(prog='dash-ci-gate.py', usage='%(prog)s --dir DIR [--container NAME] [-- PREFIX...]')
    parser.add_argument('--dir', required=True, help="the runner's install directory, as the runner's machine sees it")
    parser.add_argument('--container', help='the Docker container the runner is in, if any')
    opts = parser.parse_args(argv[:split])
    prefix = argv[split + 1:]
    try:
        command = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    except ValueError:
        command = []
    if not command or not allowed(command, opts.dir.rstrip('/'), opts.container):
        print('dash-ci-gate: refused', file=sys.stderr)
        return 126
    full = prefix + command
    os.execvp(full[0], full)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

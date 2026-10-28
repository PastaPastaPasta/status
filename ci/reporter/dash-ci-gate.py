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

NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]*')
TAIL = re.compile(r'test -f "\$1" && test ! -L "\$1" && tail -c \+[0-9]+ "\$1"( \| head -c [0-9]+)?')
COUNT = 'ls -1A "$1" | wc -l'
PS = 'ps -A -o command | grep -F -- "$1/bin/Runner." || true'
INSPECT = '{{json .State}}|{{.RestartCount}}|{{.Config.Image}}'


def allowed(argv, directory, container):
    diag = directory + '/_diag'

    def path(p):  # .runner, _diag, or a file directly in _diag
        return p in (directory + '/.runner', diag) or (p.startswith(diag + '/') and NAME.fullmatch(p[len(diag) + 1:]) is not None)

    def command(a):
        if a[:-1] in (['ls', '-1A'], ['test', '-f'], ['du', '-sb'], ['stat', '-c', '%s']):
            return path(a[-1])
        return len(a) == 5 and a[:2] == ['sh', '-c'] and a[3] == 'sh' and (a[2] == COUNT or TAIL.fullmatch(a[2]) is not None) and path(a[4])

    if not container:  # the runner's processes, not every command line on the machine
        return argv == ['sh', '-c', PS, 'sh', directory] or command(argv)
    return (argv in (['docker', 'top', container, '-eo', 'pid,args'], ['docker', 'inspect', '-f', INSPECT, container])
            or argv[:3] == ['docker', 'exec', container] and command(argv[3:]))


def main(argv):
    parser = argparse.ArgumentParser(prog='dash-ci-gate.py')
    parser.add_argument('--dir', required=True, help="the runner's install directory, as the runner's machine sees it")
    parser.add_argument('--container', help='the Docker container the runner is in, if any')
    parser.add_argument('prefix', nargs='*', help='after --: the command that runs a command where the runner is')
    opts = parser.parse_args(argv)
    try:
        command = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    except ValueError:
        command = []
    if not command or not allowed(command, opts.dir.rstrip('/'), opts.container):
        print('dash-ci-gate: refused', file=sys.stderr)
        return 126
    full = opts.prefix + command
    os.execvp(full[0], full)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))

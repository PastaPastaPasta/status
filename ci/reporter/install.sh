#!/bin/sh
# Install or update dash-ci-reporter for the current user on a runner host.
#
#   DASH_CI_TOKEN=dcr_...  DASH_CI_RUNNERS='[{"dir":"/Users/me/actions-runner"}]' \
#     sh install.sh            # run next to dash-ci-reporter.py
#
# DASH_CI_RUNNERS lists runner installs: {"dir": ...} for a runner installed on
# the host, {"container": "name"} (optionally "dir", default /runner) for one in
# Docker. DASH_CI_POOLS lists dash-ci-pool status directories, usually
# '["/run/dash-ci-pool"]'. Set either or both. Admins issue tokens on the status
# board's CI page.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home="$HOME/.dash-ci-reporter"
url=${DASH_CI_URL:-https://status.testnet.networks.dash.org/api/ci/report}
python=$(command -v python3 || true)
[ -x /usr/bin/python3 ] && python=/usr/bin/python3
[ -n "$python" ] || { echo "python3 is required" >&2; exit 1; }

mkdir -p "$home"
chmod 700 "$home"
cp "$here/dash-ci-reporter.py" "$home/dash-ci-reporter.py"
if [ -n "${DASH_CI_TOKEN:-}" ]; then
  [ -n "${DASH_CI_RUNNERS:-}${DASH_CI_POOLS:-}" ] || { echo "set DASH_CI_RUNNERS and/or DASH_CI_POOLS" >&2; exit 1; }
  umask 077
  DASH_CI_URL="$url" "$python" -c 'import json,os,sys; json.dump({"url": os.environ["DASH_CI_URL"], "token": os.environ["DASH_CI_TOKEN"], "runners": json.loads(os.environ.get("DASH_CI_RUNNERS") or "[]"), "pools": json.loads(os.environ.get("DASH_CI_POOLS") or "[]")}, open(sys.argv[1], "w"), indent=1)' "$home/config.json"
fi
[ -f "$home/config.json" ] || { echo "no $home/config.json; set DASH_CI_TOKEN and DASH_CI_RUNNERS or DASH_CI_POOLS" >&2; exit 1; }

# Check the config before the cron entry goes in.
"$python" -c 'import json,sys; c=json.load(open(sys.argv[1])); p=c.get("pools", []); assert c["token"] and (c.get("runners") or p) and isinstance(p, list) and all(isinstance(d, str) and d for d in p), "pools must be a list of directories"' "$home/config.json"
line="* * * * * $python $home/dash-ci-reporter.py >/dev/null 2>&1 # dash-ci-reporter"
( crontab -l 2>/dev/null | grep -v '# dash-ci-reporter$' || true; echo "$line" ) | crontab -
echo "dash-ci-reporter installed: $line"

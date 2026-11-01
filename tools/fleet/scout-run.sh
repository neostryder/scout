#!/bin/sh
# The child must not inherit the ingest token or the hub address.
set -eu

host=
component=
timeout=0
expect=0
class=
while [ $# -gt 0 ]; do
  case "$1" in
    --fleet-host) host=$2; shift 2 ;;
    --component) component=$2; shift 2 ;;
    --timeout-seconds) timeout=$2; shift 2 ;;
    --expect-output) expect=1; shift ;;
    --failure-class) class=$2; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if [ -z "$host" ] || [ -z "$component" ] || [ $# -lt 1 ]; then
  printf '%s\n' "usage: scout-run.sh --fleet-host name --component name -- <command>" >&2
  exit 2
fi

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

fingerprint() {
  text=$(printf '%s\n%s\n%s' "$(lower "$1")" "$(lower "$2")" "$(lower "$3")")
  if [ -n "${4:-}" ]; then
    key=$(printf '%s' "$4" | tr '[:upper:]' '[:lower:]' | awk '{ gsub(/[0-9a-f]{8,}/, "#"); gsub(/[0-9]{2,}/, "#"); printf "%s", $0 }')
    text=$(printf '%s\n%s' "$text" "$key")
  fi
  printf '%s' "$text" | openssl dgst -sha256 2>/dev/null | awk '{ print substr($NF, 1, 16) }'
}

json_escape() {
  printf '%s' "$1" | awk 'BEGIN { ORS = "" } { gsub(/\\/, "\\\\"); gsub(/"/, "\\\""); gsub(/\r/, "\\r"); gsub(/\n/, "\\n"); gsub(/\t/, "\\t"); printf "%s", $0 }'
}

redact() {
  printf '%s' "$1" | awk '
    {
      gsub(/https?:\/\/(discord(app)?\.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/, "[redacted:discord]")
      gsub(/github_pat_[A-Za-z0-9_]{20,}/, "[redacted:github]")
      gsub(/ghp_[A-Za-z0-9]{20,}/, "[redacted:github]")
      gsub(/gho_[A-Za-z0-9]{20,}/, "[redacted:github]")
      gsub(/AKIA[A-Z0-9]{16}/, "[redacted:aws]")
      gsub(/ASIA[A-Z0-9]{16}/, "[redacted:aws]")
      gsub(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, "[redacted:jwt]")
      gsub(/[Bb]earer[[:space:]]+[A-Za-z0-9._~+/=-]{8,}/, "[redacted:bearer]")
      while (match($0, /(password|passwd|secret|token|api_key|api-key|apikey|credential)[[:space:]]*[=:][[:space:]]*[^[:space:],;&]+/)) {
        pre = substr($0, 1, RSTART - 1)
        hit = substr($0, RSTART, RLENGTH)
        post = substr($0, RSTART + RLENGTH)
        if (hit ~ /\[redacted:/) break
        sepAt = match(hit, /[=:][[:space:]]*/)
        name = substr(hit, 1, sepAt + RLENGTH - 1)
        $0 = pre name "[redacted:secret]" post
      }
      printf "%s", $0
    }
  '
}

severity_for() {
  case "$1" in
    dead|wedged|resources) printf '%s' "critical" ;;
    alert-quality) printf '%s' "info" ;;
    *) printf '%s' "warning" ;;
  esac
}

post_packet() {
  body=$1
  if [ -n "${SCOUT_FLEET_SPOOL:-}" ]; then
    mkdir -p "$SCOUT_FLEET_SPOOL"
    printf '%s\n' "$body" >> "$SCOUT_FLEET_SPOOL/packets.jsonl"
  fi
  if [ -z "${SCOUT_FLEET_URL:-}" ] || [ -z "${SCOUT_FLEET_TOKEN:-}" ]; then
    return 0
  fi
  # Git Bash rewrites a leading slash in the URL unless path conversion is off.
  code=$(MSYS_NO_PATHCONV=1 curl --silent --connect-timeout 10 --max-time 10 -o /dev/null -w '%{http_code}' -X POST \
    -H 'content-type: application/json' -H "Authorization: Bearer ${SCOUT_FLEET_TOKEN}" \
    --data-binary "$body" "$SCOUT_FLEET_URL" 2>/dev/null || printf '%s' "000")
  case "$code" in
    2*) return 0 ;;
    *) printf '%s\n' "fleet post failed" >&2; return 1 ;;
  esac
}

packet_json() {
  kind=$1
  summary=$2
  recovered=$3
  prior_fp=${4:-}
  red=$(redact "$stderr_text")
  if [ -n "$prior_fp" ]; then fp=$prior_fp; else fp=$(fingerprint "$host" "$component" "$kind"); fi
  sev=$(severity_for "$kind")
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  rec=
  if [ "$recovered" = "yes" ]; then rec=',"recovered":true'; fi
  if [ "$timed_out" -eq 1 ]; then
    printf '{"version":1,"host":"%s","component":"%s","severity":"%s","failureClass":"%s","firstSeen":"%s","lastSeen":"%s","count":1,"fingerprint":"%s","summary":"%s","evidence":{"stderrTail":"%s","snapshot":{"durationMs":%s,"timedOut":true}},"redaction":{"applied":false,"rules":[]},"ownerChat":null,"runbook":null%s}' \
      "$(json_escape "$host")" "$(json_escape "$component")" "$sev" "$kind" "$now" "$now" "$fp" "$(json_escape "$summary")" "$(json_escape "$red")" "$duration_ms" "$rec"
  else
    printf '{"version":1,"host":"%s","component":"%s","severity":"%s","failureClass":"%s","firstSeen":"%s","lastSeen":"%s","count":1,"fingerprint":"%s","summary":"%s","evidence":{"exitCode":%s,"stderrTail":"%s","snapshot":{"durationMs":%s,"timedOut":false}},"redaction":{"applied":false,"rules":[]},"ownerChat":null,"runbook":null%s}' \
      "$(json_escape "$host")" "$(json_escape "$component")" "$sev" "$kind" "$now" "$now" "$fp" "$(json_escape "$summary")" "$status" "$(json_escape "$red")" "$duration_ms" "$rec"
  fi
}

tmp=${TMPDIR:-/tmp}
stdout_file=$(mktemp "$tmp/scout-fleet-out.XXXXXX")
stderr_file=$(mktemp "$tmp/scout-fleet-err.XXXXXX")
trap 'rm -f "$stdout_file" "$stderr_file"' EXIT

start=$(date +%s)
set +e
env -u SCOUT_FLEET_TOKEN -u SCOUT_FLEET_URL "$@" >"$stdout_file" 2>"$stderr_file" &
pid=$!
timed_out=0
if [ "$timeout" -gt 0 ]; then
  waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$timeout" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      timed_out=1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi
if [ "$timed_out" -eq 0 ]; then
  wait "$pid"
  status=$?
else
  status=124
fi
set -e
end=$(date +%s)
duration_ms=$(( (end - start) * 1000 ))
stdout_text=$(cat "$stdout_file" || true)
stderr_text=$(cat "$stderr_file" || true)
[ -n "$stdout_text" ] && printf '%s' "$stdout_text"
[ -n "$stderr_text" ] && printf '%s' "$stderr_text" >&2

failure=
if [ "$timed_out" -eq 1 ]; then
  failure=slow-or-timeout
elif [ "$status" -ne 0 ]; then
  if [ -n "$class" ]; then failure=$class; else failure=ran-failed; fi
elif [ "$expect" -eq 1 ] && [ -z "$stdout_text" ]; then
  failure=degraded-output
fi

if [ -n "$failure" ]; then
  body=$(packet_json "$failure" "$component on $host failed" no)
  if [ -n "${SCOUT_FLEET_SPOOL:-}" ]; then
    mkdir -p "$SCOUT_FLEET_SPOOL/open"
    fp=$(fingerprint "$host" "$component" "$failure")
    printf '%s\n%s\n%s\n%s\n' "$host" "$component" "$failure" "$fp" > "$SCOUT_FLEET_SPOOL/open/$fp"
  fi
  post_packet "$body" || true
  exit "$status"
fi

if [ -n "${SCOUT_FLEET_SPOOL:-}" ] && [ -d "$SCOUT_FLEET_SPOOL/open" ]; then
  for file in "$SCOUT_FLEET_SPOOL/open"/*; do
    [ -f "$file" ] || continue
    prior_host=$(sed -n '1p' "$file")
    prior_component=$(sed -n '2p' "$file")
    prior_class=$(sed -n '3p' "$file")
    prior_fp=$(sed -n '4p' "$file")
    [ "$prior_host" = "$host" ] && [ "$prior_component" = "$component" ] || continue
    body=$(packet_json "$prior_class" "$component on $host recovered" yes "$prior_fp")
    if post_packet "$body"; then
      rm -f "$file"
    fi
  done
fi
exit 0

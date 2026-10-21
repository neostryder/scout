# Read-only. Roots are arguments. A missing git is a marker, not a failure.
# node_modules and names starting with "_" or "." are not entered. The root
# argument itself is always entered. A .git file is a worktree or submodule.
# GNU timeout is used when it exists. macOS often does not ship it.

if ! command -v git >/dev/null 2>&1; then
  printf '%s\n' '---SCOUT-NO-GIT---'
  exit 0
fi

export GIT_OPTIONAL_LOCKS=0
export GIT_TERMINAL_PROMPT=0

have_timeout=0
if command -v timeout >/dev/null 2>&1 && timeout --version >/dev/null 2>&1; then
  have_timeout=1
fi

expand_root() {
  case "$1" in
    '~') printf '%s\n' "$HOME" ;;
    '~/'*) printf '%s\n' "$HOME/${1#??}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

run20() {
  if [ "$have_timeout" -eq 1 ]; then
    timeout 20 "$@"
    return $?
  fi
  "$@" &
  pid=$!
  i=0
  while [ "$i" -lt 20 ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      return $?
    fi
    i=$((i + 1))
    sleep 1
  done
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  return 124
}

emit_repo() {
  # local keeps a nested walk from clobbering the caller's directory.
  local dir=$1
  local abs inspect rc
  abs=$(CDPATH= cd "$dir" && pwd -P) || return 0
  inspect=$(run20 sh -c '
dir=$1
export GIT_OPTIONAL_LOCKS=0
export GIT_TERMINAL_PROMPT=0
first() { printf "%s\n" "$1" | head -n 1 | tr -d "\r"; }
remote=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
if [ -z "$remote" ]; then
  name=$(git -C "$dir" remote 2>/dev/null | head -n 1 | tr -d "\r")
  if [ -n "$name" ]; then
    remote=$(git -C "$dir" remote get-url "$name" 2>/dev/null || true)
  fi
fi
case "$remote" in
  *://*:*@*)
    scheme=${remote%%://*}
    rest=${remote#*://}
    rest=${rest#*@}
    remote="$scheme://$rest"
    ;;
esac
remote=$(first "$remote")
commit=$(first "$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)")
branch=$(first "$(git -C "$dir" symbolic-ref --short HEAD 2>/dev/null || true)")
default=$(first "$(git -C "$dir" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || true)")
describe=$(first "$(git -C "$dir" describe --tags --always --long 2>/dev/null || true)")
dirty=$(git -C "$dir" status --porcelain 2>/dev/null | wc -l | tr -d " \r")
ab=$(git -C "$dir" rev-list --left-right --count "HEAD...@{upstream}" 2>/dev/null || true)
ahead=
behind=
set -- $ab
ahead=${1-}
behind=${2-}
committed=$(first "$(git -C "$dir" log -1 --format=%cI 2>/dev/null || true)")
tag=$(first "$(git -C "$dir" describe --tags --abbrev=0 2>/dev/null || true)")
printf "remote=%s\ncommit=%s\nbranch=%s\ndefault=%s\ndescribe=%s\ndirty=%s\nahead=%s\nbehind=%s\ncommitted=%s\ntag=%s\n" "$remote" "$commit" "$branch" "$default" "$describe" "$dirty" "$ahead" "$behind" "$committed" "$tag"
' _ "$abs")
  rc=$?
  if [ "$rc" -eq 124 ]; then
    printf '%s\n' '---SCOUT-SKIP---' "path=$abs" 'reason=timeout'
    return 0
  fi
  printf '%s\n' '---SCOUT-REPO---' "path=$abs"
  printf '%s\n' "$inspect"
}

scan_dir() {
  # local keeps the caller's depth. A shared depth stops the walk at the first nested directory.
  local dir=$1
  local depth=$2
  local explicit=$3
  local name child
  if [ ! -d "$dir" ]; then
    return 0
  fi
  if [ "$explicit" != 1 ] && [ -L "$dir" ]; then
    return 0
  fi
  name=${dir##*/}
  if [ "$explicit" != 1 ]; then
    case "$name" in
      node_modules|_*|.*) return 0 ;;
    esac
  fi
  if [ -d "$dir/.git" ] && [ ! -L "$dir/.git" ]; then
    emit_repo "$dir"
    return 0
  fi
  if [ -e "$dir/.git" ]; then
    return 0
  fi
  if [ "$depth" -ge 3 ]; then
    return 0
  fi
  for child in "$dir"/* "$dir"/.[!.]* "$dir"/..?*; do
    if [ -d "$child" ] && [ ! -L "$child" ]; then
      scan_dir "$child" $((depth + 1)) 0
    fi
  done
}

for raw in "$@"; do
  root=$(expand_root "$raw")
  scan_dir "$root" 0 1
done
exit 0

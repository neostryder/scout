command -v rpm-ostree >/dev/null 2>&1 || { echo "rpm-ostree is not installed" >&2; exit 127; }
export LC_ALL=C
status=$(rpm-ostree status 2>/dev/null)
rc=$?
echo "---SCOUT-STATUS---"
printf '%s\n' "$status"
echo "exit=$rc"
echo "---SCOUT-REMOTE---"
ref=$(printf '%s\n' "$status" | sed -n 's/^[ *]*ostree[^:]*:docker:\/\/\([^ ]*\).*/\1/p' | head -1)
if [ -n "$ref" ] && command -v skopeo >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  timeout 60 skopeo inspect --no-tags --config "docker://$ref" 2>/dev/null
  echo "exit=$?"
else
  echo "exit=127"
fi

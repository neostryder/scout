command -v flatpak >/dev/null 2>&1 || { echo "flatpak is not installed" >&2; exit 127; }
export LC_ALL=C
for inst in system user; do
  echo "---SCOUT-LIST-$inst---"
  flatpak list --app --$inst --columns=application,name,version,branch,origin,installation,description 2>/dev/null
  echo "exit=$?"
  echo "---SCOUT-UPDATES-$inst---"
  if command -v timeout >/dev/null 2>&1; then
    timeout 60 flatpak remote-ls --$inst --updates --app --columns=application,version,branch,origin 2>/dev/null
  else
    flatpak remote-ls --$inst --updates --app --columns=application,version,branch,origin 2>/dev/null
  fi
  echo "exit=$?"
done

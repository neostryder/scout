for f in /Library/LaunchDaemons/*.plist /Library/LaunchAgents/*.plist "$HOME"/Library/LaunchAgents/*.plist; do
  [ -f "$f" ] || continue
  printf '%s\t' "$f"; plutil -convert json -o - "$f" 2>/dev/null | tr -d '\n'; echo
done

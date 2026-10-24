for f in "$HOME"/Library/LaunchAgents/*.plist /Library/LaunchAgents/*.plist /Library/LaunchDaemons/*.plist; do
  [ -f "$f" ] || continue
  t=$(plutil -convert xml1 -o - "$f" 2>/dev/null) || continue
  case "$t" in
    */Repositories/*|*/_worktrees/*) printf -- '---SCOUT-ITEM---launchd\t%s\n%s\n' "$f" "$t" ;;
  esac
done

for f in /etc/systemd/system/*.service "$HOME"/.config/systemd/user/*.service "$HOME"/.config/autostart/*.desktop; do
  [ -f "$f" ] || continue
  case "$f" in *.desktop) kind=autostart ;; *) kind=systemd ;; esac
  if grep -qE '/(Repositories|_worktrees)/' "$f" 2>/dev/null; then
    printf -- '---SCOUT-ITEM---%s\t%s\n' "$kind" "$f"
    head -c 8192 "$f"
    printf '\n'
  fi
done

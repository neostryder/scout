for d in "$HOME/.local/bin" "$HOME/.cargo/bin" "$HOME/go/bin"; do
  [ -d "$d" ] || continue
  for f in "$d"/*; do
    [ -f "$f" ] && [ -x "$f" ] || continue
    printf '%s\t%s\n' "$f" "$(readlink "$f")"
  done
done

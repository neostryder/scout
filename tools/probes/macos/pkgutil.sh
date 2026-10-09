for id in $(pkgutil --pkgs | grep -v '^com\.apple\.'); do
  info=$(pkgutil --pkg-info "$id" 2>/dev/null)
  v=$(printf '%s\n' "$info" | sed -n 's/^version: //p')
  vol=$(printf '%s\n' "$info" | sed -n 's/^volume: //p')
  loc=$(printf '%s\n' "$info" | sed -n 's/^location: //p')
  printf '%s\t%s\t%s\t%s\n' "$id" "$v" "$vol" "$loc"
done

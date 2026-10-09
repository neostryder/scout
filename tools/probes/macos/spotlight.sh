for a in /Applications/*.app /Applications/*/*.app "$HOME"/Applications/*.app; do
  [ -d "$a" ] || continue
  printf '%s\t%s\t%s\n' "$a" "$(mdls -raw -name kMDItemLastUsedDate "$a" 2>/dev/null)" "$(mdls -raw -name kMDItemUseCount "$a" 2>/dev/null)"
done

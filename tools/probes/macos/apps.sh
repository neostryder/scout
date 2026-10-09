for a in /Applications/*.app /Applications/*/*.app "$HOME"/Applications/*.app; do
  [ -d "$a" ] || continue
  p="$a/Contents/Info.plist"; [ -f "$p" ] || continue
  g() { /usr/libexec/PlistBuddy -c "Print :$1" "$p" 2>/dev/null; }
  printf '%s\t%s\t%s\t%s\t%s\n' "$a" "$(g CFBundleIdentifier)" "$(g CFBundleShortVersionString)" "$(g CFBundleVersion)" "$(g SUFeedURL)"
done

d="${GOBIN:-$(go env GOPATH)/bin}"
for f in "$d"/*; do
  [ -f "$f" ] && [ -x "$f" ] || continue
  printf '%s\t' "$f"
  go version -m "$f" 2>/dev/null | awk -F'\t' '$2=="path"{p=$3} $2=="mod"{m=$3; v=$4} END{printf "%s\t%s\t%s", p, m, v}'
  echo
done

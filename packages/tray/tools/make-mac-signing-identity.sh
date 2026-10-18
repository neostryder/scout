#!/bin/sh
# Creates a local self-signed code-signing identity for building the Scout tray on a Mac, in its own keychain so no password prompt is needed.
# Signing every build with the same identity keeps the Keychain's "Always Allow" for the saved hub secret across rebuilds.
# Build with: security unlock-keychain -p "" ~/Library/Keychains/scout-signing.keychain-db && APPLE_SIGNING_IDENTITY="Scout Local Signing" pnpm exec tauri build
set -eu
NAME="Scout Local Signing"
KC="$HOME/Library/Keychains/scout-signing.keychain-db"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -f "$KC" ] && security find-certificate -c "$NAME" "$KC" >/dev/null 2>&1; then
  echo "The $NAME identity already exists in $KC"
  exit 0
fi

cat >"$WORK/openssl.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Scout Local Signing
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$WORK/openssl.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" -out "$WORK/id.p12" -passout pass:scout

[ -f "$KC" ] || security create-keychain -p "" "$KC"
security set-keychain-settings "$KC"
security unlock-keychain -p "" "$KC"
security import "$WORK/id.p12" -k "$KC" -P scout -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "" "$KC" >/dev/null

# Put the keychain on the user's search list so codesign finds the identity.
CURRENT="$(security list-keychains -d user | tr -d '"' | tr '\n' ' ')"
# shellcheck disable=SC2086
security list-keychains -d user -s "$KC" $CURRENT

echo "Created the $NAME identity in $KC"
security find-identity -p codesigning "$KC" | tail -2

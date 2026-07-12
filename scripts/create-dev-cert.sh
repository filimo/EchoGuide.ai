#!/usr/bin/env bash
set -euo pipefail

cert_dir=".certs"
key_path="$cert_dir/echoguide-dev.key"
cert_path="$cert_dir/echoguide-dev.crt"
dev_host="${ECHOGUIDE_DEV_HOST:-localhost}"

mkdir -p "$cert_dir"

hosts=(localhost 127.0.0.1 ::1)

if [ "$dev_host" != "localhost" ]; then
  hosts+=("$dev_host")
fi

if command -v mkcert >/dev/null 2>&1; then
  mkcert -install
  mkcert \
    -key-file "$key_path" \
    -cert-file "$cert_path" \
    "${hosts[@]}"
  printf 'created trusted local HTTPS certificate %s and %s via mkcert\n' "$key_path" "$cert_path"
  exit 0
fi

printf 'mkcert not found; creating a self-signed certificate fallback\n' >&2
printf 'install mkcert and rerun npm run dev:cert for a certificate trusted by macOS/iPad\n' >&2

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -sha256 \
  -days 30 \
  -nodes \
  -keyout "$key_path" \
  -out "$cert_path" \
  -subj "/CN=$dev_host" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1${dev_host:+,DNS:$dev_host}"

printf 'created self-signed local HTTPS certificate %s and %s\n' "$key_path" "$cert_path"

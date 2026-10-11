#!/bin/sh
# A certificate for the laptops in the room.
#
# Not about secrecy. Browsers only hand out AudioWorklet in a secure context,
# and plain http to a LAN address is not one — so without this every player's
# laptop runs the synth on its main thread and the NaN guard runs the slow way.
# A self-signed certificate is enough to get the good path; players click
# through the warning once.
#
#   ./scan/make-cert.sh
#   node scan/scan-bridge.js --cert scan/tract-cert.pem --key scan/tract-key.pem
#
# The certificate covers this machine's addresses AS THEY ARE NOW. Change
# network — a different room, a different router — and you run it again.
set -e
cd "$(dirname "$0")"

DAYS=${DAYS:-60}
KEY=tract-key.pem
CRT=tract-cert.pem

ips=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -v '^127\.' || true)
if [ -z "$ips" ]; then
  ips=$(hostname -I 2>/dev/null || true)
fi

san="DNS:localhost,IP:127.0.0.1"
for ip in $ips; do
  san="$san,IP:$ip"
done

cfg=$(mktemp)
cat > "$cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Tract
[ext]
subjectAltName = $san
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout "$KEY" -out "$CRT" -config "$cfg" >/dev/null 2>&1
rm -f "$cfg"
chmod 600 "$KEY"

echo "wrote scan/$CRT and scan/$KEY, good for $DAYS days"
echo "covering: $san"
echo
echo "now start the bridge with:"
echo "  node scan/scan-bridge.js --cert scan/$CRT --key scan/$KEY"

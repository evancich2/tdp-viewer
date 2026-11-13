#!/bin/sh
# Regenerates the RFC 3161 test fixtures in tests/fixtures/tsa/ with a throwaway local CA and TSA
# (needs OpenSSL 3 with the `ts` command). Private keys are created in a temp dir and deleted;
# only certificates, the request and the responses are kept. Test data only: not a real TSA.
set -eu
OUT=tests/fixtures/tsa
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
DIGEST=$(printf 'tdp tsa fixture' | openssl dgst -sha256 -r | cut -d' ' -f1)
cat > "$T/ext.cnf" <<CNF
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
[tsa]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=critical,timeStamping
[plain]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
CNF
cat > "$T/ts.cnf" <<CNF
[ tsa ]
default_tsa = tsa_config
[ tsa_config ]
serial = $T/serial
signer_digest = sha256
default_policy = 1.2.3.4.1
digests = sha256
accuracy = secs:1
ess_cert_id_alg = sha256
CNF
echo 01 > "$T/serial"
mk() { # name subj ext issuerkey issuercert
  openssl ecparam -name prime256v1 -genkey -noout -out "$T/$1.key"
  openssl req -new -key "$T/$1.key" -subj "$2" -out "$T/$1.csr"
  if [ "$3" = ca ]; then openssl x509 -req -in "$T/$1.csr" -signkey "$T/$1.key" -days 3650 -extfile "$T/ext.cnf" -extensions ca -out "$T/$1.pem" 2>/dev/null
  else openssl x509 -req -in "$T/$1.csr" -CA "$T/$4.pem" -CAkey "$T/$4.key" -CAcreateserial -days 3650 -extfile "$T/ext.cnf" -extensions "$3" -out "$T/$1.pem" 2>/dev/null; fi
}
mk ca "/CN=TDP Test TSA Root (fixture)" ca
mk tsa "/CN=TDP Test TSA (fixture)" tsa ca
mk plain "/CN=Not A TSA (fixture)" plain ca
mk other "/CN=Unrelated Root (fixture)" ca
npx tsx -e "import { timestampRequest } from './tools/timestamp'; import { writeFileSync } from 'node:fs'; writeFileSync('$T/req.der', timestampRequest('$DIGEST', Buffer.from('0102030405060708', 'hex')).der);"
openssl ts -reply -config "$T/ts.cnf" -queryfile "$T/req.der" -inkey "$T/tsa.key" -signer "$T/tsa.pem" -chain "$T/ca.pem" -out "$OUT/response.der" 2>/dev/null
openssl ts -reply -config "$T/ts.cnf" -queryfile "$T/req.der" -inkey "$T/plain.key" -signer "$T/plain.pem" -out "$OUT/response-not-tsa.der" 2>/dev/null || true
cp "$T/ca.pem" "$OUT/ca.pem"; cp "$T/tsa.pem" "$OUT/tsa.pem"; cp "$T/other.pem" "$OUT/other-root.pem"
printf '%s\n' "$DIGEST" > "$OUT/digest.txt"
openssl ts -verify -in "$OUT/response.der" -queryfile "$T/req.der" -CAfile "$OUT/ca.pem" >/dev/null && echo "openssl verifies the fixture response"
ls "$OUT"

#!/usr/bin/env bash
# Renovação de certificado mTLS Itaú (quando o atual vencer ou o STS retornar 409 "ainda válido").
#
# Pré-requisitos:
#   - Token temporário (7 dias) do e-mail Itaú em Conexao_Itau/Tokens e Credencial.txt
#   - openssl instalado
#
# Uso:
#   export ITAU_CLIENT_ID=74664a19-79c6-480c-b7c6-dd5164080f3b
#   export ITAU_TEMP_TOKEN='eyJ...'   # Bearer do e-mail
#   ./scripts/renovar-certificado-itau.sh
#
# Saída em scripts/itau-certs/ (gitignored): .key, .csr, client_secret.txt, certificado.crt

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="$ROOT/scripts/itau-certs"
CLIENT_ID="${ITAU_CLIENT_ID:?defina ITAU_CLIENT_ID}"
TEMP_TOKEN="${ITAU_TEMP_TOKEN:?defina ITAU_TEMP_TOKEN (Bearer do e-mail Itaú)}"

mkdir -p "$CERT_DIR"
KEY="$CERT_DIR/veramo-itau-bridge.key"
CSR="$CERT_DIR/veramo-itau-bridge.csr"
RESP="$CERT_DIR/solicitacao-response.txt"

if [[ ! -f "$KEY" ]]; then
  echo "→ Gerando KEY + CSR (CN=$CLIENT_ID)..."
  openssl req -new \
    -subj "/CN=${CLIENT_ID}/OU=Veramo/L=Santo Andre/ST=SP/C=BR" \
    -out "$CSR" -nodes -sha512 -newkey rsa:2048 -keyout "$KEY"
else
  echo "→ KEY existente; reutilizando $KEY"
  [[ -f "$CSR" ]] || openssl req -new -key "$KEY" -out "$CSR" -nodes -sha512 \
    -subj "/CN=${CLIENT_ID}/OU=Veramo/L=Santo Andre/ST=SP/C=BR"
fi

echo "→ Enviando CSR para sts.itau.com.br..."
HTTP=$(curl -sS -w "%{http_code}" -o "$RESP" \
  -X POST "https://sts.itau.com.br/seguranca/v1/certificado/solicitacao" \
  -H "Authorization: Bearer ${TEMP_TOKEN}" \
  -H "Content-Type: text/plain" \
  --data-binary @"$CSR")

echo "HTTP $HTTP — resposta em $RESP"

if [[ "$HTTP" == "409" ]]; then
  echo "Certificado ainda válido no Itaú. Nenhuma ação necessária."
  exit 0
fi

if [[ "$HTTP" != "200" ]]; then
  echo "Falha na solicitação. Verifique token temporário (expira em ~7 dias)."
  exit 1
fi

SECRET=$(head -1 "$RESP")
tail -n +2 "$RESP" | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' > "$CERT_DIR/certificado.crt"
echo "$SECRET" > "$CERT_DIR/client_secret.txt"

echo "✓ client_secret → $CERT_DIR/client_secret.txt"
echo "✓ certificado.crt → $CERT_DIR/certificado.crt"
echo ""
echo "Próximo passo: atualizar Railway com ITAU_CLIENT_ID, ITAU_CLIENT_SECRET, ITAU_CERT_PEM, ITAU_KEY_PEM, ITAU_API_KEY"

#!/usr/bin/env bash
# Validação do webhook Itaú Boletos v3 — Veramo 2.0
# Uso:
#   cp .env.example .env   # preencher variáveis
#   source .env            # ou export manualmente
#   ./scripts/validate-itau-webhook.sh          # todas as fases possíveis
#   ./scripts/validate-itau-webhook.sh phase0     # só infra
#   ./scripts/validate-itau-webhook.sh phase1     # cadastro no Itaú
#
# Variáveis necessárias:
#   BRIDGE_URL, BRIDGE_ACCESS_TOKEN
#   SUPABASE_PROJECT_REF (ex: mnlulratuueetbhlywkd)
#   ITAU_BENEFICIARIO_ID
#   ITAU_WEBHOOK_CLIENT_ID, ITAU_WEBHOOK_CLIENT_SECRET (fases 2–3)

set -euo pipefail

# Carrega scripts/validate.env automaticamente (variáveis precisam de export no arquivo)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/validate.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
fi

PHASE="${1:-all}"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ PASS${NC} $*"; }
fail() { echo -e "${RED}✗ FAIL${NC} $*"; }
warn() { echo -e "${YELLOW}! WARN${NC} $*"; }
info() { echo -e "  → $*"; }

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "Variável $name não definida."
    exit 1
  fi
}

BRIDGE_URL="${BRIDGE_URL:-}"
BRIDGE_ACCESS_TOKEN="${BRIDGE_ACCESS_TOKEN:-}"
SUPABASE_PROJECT_REF="${SUPABASE_PROJECT_REF:-mnlulratuueetbhlywkd}"
ITAU_BENEFICIARIO_ID="${ITAU_BENEFICIARIO_ID:-}"
ITAU_WEBHOOK_CLIENT_ID="${ITAU_WEBHOOK_CLIENT_ID:-}"
ITAU_WEBHOOK_CLIENT_SECRET="${ITAU_WEBHOOK_CLIENT_SECRET:-}"

OAUTH_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/itau-webhook-token"
WEBHOOK_URL="https://${SUPABASE_PROJECT_REF}.supabase.co/functions/v1/itau-boleto-webhook"

run_phase0() {
  echo ""
  echo "=== Fase 0 — Infraestrutura ==="

  if [[ -n "$BRIDGE_URL" ]]; then
    local health
    health=$(curl -sS -m 15 "${BRIDGE_URL%/}/healthz" 2>/dev/null || true)
    if echo "$health" | grep -q '"ok"'; then
      pass "Bridge healthz: ${BRIDGE_URL%/}/healthz"
    else
      fail "Bridge healthz não respondeu OK: $health"
    fi
  else
    warn "BRIDGE_URL não definido — pulando healthz do bridge"
  fi

  local code_oauth code_webhook
  code_oauth=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" -X POST "$OAUTH_URL" 2>/dev/null || echo "000")
  if [[ "$code_oauth" != "000" ]]; then
    pass "Edge OAuth alcançável (HTTP $code_oauth — esperado 401 sem Basic Auth)"
  else
    fail "Edge OAuth inalcançável: $OAUTH_URL"
  fi

  code_webhook=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo "000")
  if [[ "$code_webhook" != "000" ]]; then
    pass "Edge webhook alcançável (HTTP $code_webhook — esperado 401 sem Bearer)"
  else
    fail "Edge webhook inalcançável: $WEBHOOK_URL"
  fi

  info "OAUTH_URL=$OAUTH_URL"
  info "WEBHOOK_URL=$WEBHOOK_URL"
}

run_phase1() {
  echo ""
  echo "=== Fase 1 — Cadastro no Itaú (API Boletos v3) ==="
  require_var BRIDGE_URL
  require_var BRIDGE_ACCESS_TOKEN
  require_var ITAU_BENEFICIARIO_ID

  local url="${BRIDGE_URL%/}/v1/boleto-webhook-check?id_beneficiario=${ITAU_BENEFICIARIO_ID}"
  info "GET $url"

  local body http_code
  body=$(curl -sS -m 30 -w "\n%{http_code}" "$url" \
    -H "x-bridge-token: $BRIDGE_ACCESS_TOKEN" 2>/dev/null || echo -e "\n000")
  http_code=$(echo "$body" | tail -n1)
  body=$(echo "$body" | sed '$d')

  echo "$body" | jq . 2>/dev/null || echo "$body"

  if [[ "$http_code" =~ ^2 ]]; then
    if echo "$body" | jq -e '.registros | length > 0' >/dev/null 2>&1; then
      pass "Itaú retornou ao menos um registro de webhook"
      echo "$body" | jq -r '.registros[]? | "  webhook_url: \(.webhook_url)\n  webhook_oauth_url: \(.webhook_oauth_url)"' 2>/dev/null || true
    else
      warn "HTTP $http_code mas registros vazios — webhook provavelmente NÃO cadastrado para este beneficiário"
      info "Próximo passo: POST /v1/boleto-webhook-register com id_beneficiario"
    fi
  else
    fail "boleto-webhook-check HTTP $http_code"
  fi
}

run_phase2() {
  echo ""
  echo "=== Fase 2 — OAuth simulado (Itaú) ==="
  require_var ITAU_WEBHOOK_CLIENT_ID
  require_var ITAU_WEBHOOK_CLIENT_SECRET

  local basic token_resp http_code
  basic=$(printf '%s:%s' "$ITAU_WEBHOOK_CLIENT_ID" "$ITAU_WEBHOOK_CLIENT_SECRET" | base64 | tr -d '\n')

  token_resp=$(curl -sS -m 25 -w "\n%{http_code}" -X POST "$OAUTH_URL" \
    -H "Authorization: Basic $basic" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=client_credentials" 2>/dev/null || echo -e "\n000")
  http_code=$(echo "$token_resp" | tail -n1)
  token_resp=$(echo "$token_resp" | sed '$d')

  echo "$token_resp" | jq . 2>/dev/null || echo "$token_resp"

  if [[ "$http_code" == "200" ]] && echo "$token_resp" | jq -e '.access_token' >/dev/null 2>&1; then
    pass "OAuth token obtido (HTTP 200)"
    export VALIDATION_ACCESS_TOKEN
    VALIDATION_ACCESS_TOKEN=$(echo "$token_resp" | jq -r '.access_token')
  else
    fail "OAuth falhou (HTTP $http_code) — conferir secrets Supabase vs Itaú"
    return 1
  fi

  echo ""
  info "Teste Bearer inválido no webhook..."
  local bad_code
  bad_code=$(curl -sS -m 20 -o /dev/null -w "%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Authorization: Bearer invalido-teste" \
    -H "Content-Type: application/json" \
    -d '{"boletos":[{"numeroNossoNumero":"00000001","tipoLiquidacao":"LIQUIDADO"}]}' 2>/dev/null || echo "000")
  if [[ "$bad_code" == "401" ]]; then
    pass "Webhook rejeitou token inválido (401)"
  else
    warn "Webhook respondeu HTTP $bad_code para token inválido (esperado 401)"
  fi
}

run_phase3() {
  echo ""
  echo "=== Fase 3 — Notificação simulada ==="

  if [[ -z "${VALIDATION_ACCESS_TOKEN:-}" ]]; then
    run_phase2 || true
  fi
  if [[ -z "${VALIDATION_ACCESS_TOKEN:-}" ]]; then
    fail "Sem access_token — execute phase2 com credenciais corretas"
    return 1
  fi

  local payload='{"boletos":[{"numeroNossoNumero":"00000001","tipoLiquidacao":"LIQUIDADO","valorPagoTotalCobranca":"1.00"}]}'
  local resp http_code
  resp=$(curl -sS -m 30 -w "\n%{http_code}" -X POST "$WEBHOOK_URL" \
    -H "Authorization: Bearer $VALIDATION_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload" 2>/dev/null || echo -e "\n000")
  http_code=$(echo "$resp" | tail -n1)
  resp=$(echo "$resp" | sed '$d')

  echo "$resp" | jq . 2>/dev/null || echo "$resp"

  if [[ "$http_code" == "200" ]] && echo "$resp" | grep -q 'received'; then
    pass "Webhook aceitou notificação simulada (HTTP 200)"
    info "Verifique no Supabase SQL:"
    info "  SELECT * FROM itau_webhook_events ORDER BY created_at DESC LIMIT 5;"
    info "Logs: Dashboard → Edge Functions → itau-boleto-webhook"
  else
    fail "Notificação simulada falhou (HTTP $http_code)"
  fi
}

main() {
  echo "Validação webhook Itaú — fase: $PHASE"
  echo "Projeto Supabase: $SUPABASE_PROJECT_REF"

  case "$PHASE" in
    phase0) run_phase0 ;;
    phase1) run_phase0; run_phase1 ;;
    phase2) run_phase0; run_phase2 ;;
    phase3) run_phase0; run_phase2; run_phase3 ;;
    all)
      run_phase0
      if [[ -n "$ITAU_BENEFICIARIO_ID" && -n "$BRIDGE_URL" && -n "$BRIDGE_ACCESS_TOKEN" ]]; then
        run_phase1
      else
        warn "Pulando Fase 1 — defina ITAU_BENEFICIARIO_ID, BRIDGE_URL, BRIDGE_ACCESS_TOKEN"
      fi
      if [[ -n "$ITAU_WEBHOOK_CLIENT_ID" && -n "$ITAU_WEBHOOK_CLIENT_SECRET" ]]; then
        run_phase2
        run_phase3
      else
        warn "Pulando Fases 2–3 — defina ITAU_WEBHOOK_CLIENT_ID e ITAU_WEBHOOK_CLIENT_SECRET"
      fi
      ;;
    *)
      echo "Uso: $0 [phase0|phase1|phase2|phase3|all]"
      exit 1
      ;;
  esac

  echo ""
  echo "Concluído. Registre resultados em docs/WEBHOOK_VALIDATION_PLAN.md"
}

main

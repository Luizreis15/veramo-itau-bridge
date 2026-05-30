# Checklist — teste real de pagamento Itaú

Use **depois** de emitir a cobrança no Veramo e **antes/depois** de pagar o PIX.

## Antes de pagar

1. Anote o **ID da cobrança** (UUID) e o **valor**.
2. No Supabase SQL Editor:

```sql
SELECT id, nosso_numero, provider_charge_id, payment_status, created_at
FROM charges
WHERE id = '<CHARGE_ID>';
```

Confirme que `nosso_numero` **não está null** (8 dígitos, ex.: `49459455`).

3. (Opcional) Validação rápida da infra:

```bash
./scripts/validate-itau-webhook.sh phase0
```

## Imediatamente após pagar o PIX

Aguarde **2–5 minutos** (Itaú pode demorar; BAIXA_OPERACIONAL às vezes leva mais).

### 1. Eventos webhook

```sql
SELECT id, event_type, status, charge_id, created_at, raw_payload
FROM itau_webhook_events
ORDER BY created_at DESC
LIMIT 10;
```

Esperado: linha nova com `event_type` = `boleto` ou `pix`, `status` = `processed` ou `matched`.

### 2. Status da cobrança

```sql
SELECT c.id, c.payment_status, c.paid_at, c.nosso_numero, a.status AS appointment_status
FROM charges c
LEFT JOIN appointments a ON a.id = c.appointment_id
WHERE c.id = '<CHARGE_ID>';
```

Esperado: `payment_status` = `paid`, appointment `payment_confirmed`.

### 3. Logs Supabase

Dashboard → Edge Functions → Logs (horário do pagamento):

- `itau-boleto-webhook` — `payload recebido`, `confirmado pago`
- `itau-webhook` — `payment_confirmed` (se PIX notificar por este canal)

## Se continuar `pending` após 10 min

1. Confirme cadastro Itaú (local):

```bash
source scripts/validate.env
curl -s "$BRIDGE_URL/v1/boleto-webhook-check?id_beneficiario=$ITAU_BENEFICIARIO_ID" \
  -H "x-bridge-token: $BRIDGE_ACCESS_TOKEN" | jq '.registros[].webhook_url'

curl -s "$BRIDGE_URL/v1/webhook-check?pix_key=$PIX_KEY&api_base_url=https://secure.api.itau/pix_recebimentos/v2" \
  -H "x-bridge-token: $BRIDGE_ACCESS_TOKEN" | jq .
```

2. Simule o handler (prova que **nosso lado** funciona):

```bash
./scripts/validate-itau-webhook.sh phase3
```

3. Abra chamado Itaú com: `nosso_numero`, horário do pagamento, beneficiário `151400969995`.

## Dados de referência

| Item | Valor |
|------|--------|
| Beneficiário | `151400969995` |
| Chave PIX | `pix@secabc.org.br` |
| OAuth webhook | `.../itau-webhook-token` |
| POST boleto | `.../itau-boleto-webhook` |
| POST PIX (Itaú) | `.../itau-webhook/pix` |

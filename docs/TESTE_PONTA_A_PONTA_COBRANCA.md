# Teste ponta a ponta — cobrança real + webhook

Use depois que Fase 1 (cadastro Itaú) já passou.

---

## Antes de pagar — anotar IDs (SQL no Supabase)

Rode **logo após** gerar a cobrança no app (passo 2 do wizard):

```sql
SELECT
  c.id AS charge_id,
  c.provider_charge_id,
  c.payment_status,
  c.billing_type,
  c.created_at,
  a.id AS appointment_id,
  a.status AS appointment_status,
  u.itau_beneficiario_id
FROM charges c
JOIN appointments a ON a.id = c.appointment_id
JOIN unions u ON u.id = c.union_id
WHERE c.provider = 'itau_bolecode'
ORDER BY c.created_at DESC
LIMIT 1;
```

**Copie e guarde:**

- `charge_id`
- `provider_charge_id` (8 dígitos = bom para webhook; UUID/BL... = matching mais frágil)
- `appointment_id`

---

## Pagar

- **PIX:** pague pelo QR/copia e cola da cobrança que acabou de criar.
- **Boleto:** compensação pode levar até ~2 dias; para teste rápido prefira **PIX**.

Aguarde **2–5 minutos** após o pagamento confirmar no app do banco.

---

## Depois de pagar — SQL 1 (webhook chegou?)

```sql
SELECT id, nosso_numero, status, charge_id, amount, created_at
FROM itau_webhook_events
ORDER BY created_at DESC
LIMIT 10;
```

| O que ver | Significado |
|-----------|-------------|
| Linha nova com `charge_id` = seu `charge_id` e `status = processed` | Webhook OK + matching OK |
| Linha nova com `status = received` e `charge_id` null | Itaú avisou, **não achou** cobrança |
| Nenhuma linha nova após o horário do pagamento | Itaú **não chamou** o webhook |

---

## Depois de pagar — SQL 2 (sistema atualizou?)

Substitua `SEU_CHARGE_ID`:

```sql
SELECT
  c.id,
  c.provider_charge_id,
  c.payment_status,
  c.paid_at,
  a.status AS appointment_status,
  a.payment_status AS appointment_payment_status
FROM charges c
JOIN appointments a ON a.id = c.appointment_id
WHERE c.id = 'SEU_CHARGE_ID';
```

**Esperado se tudo OK:**

- `charges.payment_status` = `paid`
- `appointments.payment_status` = `paid`
- `appointments.status` = `payment_confirmed`

---

## Logs — Supabase

1. Dashboard → projeto `mnlulratuueetbhlywkd`
2. **Edge Functions** → Logs (ou cada função):
   - `itau-webhook-token` — após pagamento, deve ter log de token gerado
   - `itau-boleto-webhook` — procure `payload recebido`, `confirmado pago` ou `cobrança não encontrada`

Filtro por horário do pagamento.

---

## Logs — Railway (bridge)

Só se quiser ver emissão da cobrança:

1. Railway → `veramo-itau-bridge-production`
2. **Deployments** → **View logs**
3. Procure `[charges] POST` no horário em que gerou a cobrança no app

O **pagamento** não passa pelo bridge — só emissão.

---

## Opcional — forçar sync (se webhook demorar)

No app, na tela de pagamento (PIX), o front chama polling `sync-payment-status` a cada 15s.

Ou via API (com JWT de usuário empresa) — função `sync-payment-status` com body `{ "charge_id": "..." }`.

Se após 5 min o SQL 1 estiver vazio mas o sync atualizar para `paid`, o problema é **só webhook Itaú**, não o fluxo inteiro.

---

## O que me enviar depois do teste

1. Resultado do SQL **antes** (charge_id + provider_charge_id)
2. Horário aproximado do pagamento + método (PIX/boleto)
3. Resultado SQL 1 e SQL 2
4. Print ou texto dos logs `itau-boleto-webhook` (últimas linhas no horário do pagamento)

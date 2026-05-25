# Plano de validação — Webhook Itaú (Boleto v3)

Objetivo: **provar onde o webhook existe (ou não)** antes de corrigir código.
Não envolve frontend. Não exige pagamento real na Fase 1–4.

---

## Pré-requisitos

| Item | Onde obter |
|------|------------|
| `BRIDGE_URL` + `BRIDGE_ACCESS_TOKEN` | Deploy do `veramo-itau-bridge` / `.env` |
| `ITAU_BENEFICIARIO_ID` | Tabela `unions.itau_beneficiario_id` ou legado audit |
| `SUPABASE_PROJECT_REF` | Ex.: `mnlulratuueetbhlywkd` |
| `ITAU_WEBHOOK_CLIENT_ID` / `SECRET` | Supabase Secrets + portal Itaú (cadastro webhook) |
| `ITAU_WEBHOOK_TOKEN_SECRET` | Supabase Secret (`itau-webhook-token` / `itau-boleto-webhook`) |

URLs esperadas (projeto B — Veramo 2.0):

```
OAUTH:  https://<PROJECT_REF>.supabase.co/functions/v1/itau-webhook-token
POST:   https://<PROJECT_REF>.supabase.co/functions/v1/itau-boleto-webhook
PIX:    https://<PROJECT_REF>.supabase.co/functions/v1/itau-webhook
```

URLs esperadas (projeto A — audit VPS):

```
OAUTH:  https://<DOMINIO_VPS>/api/itau/webhook/auth/
POST:   https://<DOMINIO_VPS>/api/itau/webhook/notificacoes/
```

---

## Fase 0 — Checklist rápido (5 min)

| # | Teste | Comando / ação | Passa se |
|---|--------|----------------|----------|
| 0.1 | Bridge no ar | `curl -s $BRIDGE_URL/healthz` | `{"ok":true,...}` |
| 0.2 | Edge OAuth responde | `curl -s -o /dev/null -w "%{http_code}" -X POST $OAUTH_URL` | ≠ 000 (timeout) |
| 0.3 | Edge webhook responde | `curl -s -o /dev/null -w "%{http_code}" -X POST $WEBHOOK_URL` | ≠ 000 |

Script automatizado: `./scripts/validate-itau-webhook.sh` (modo `phase0`).

---

## Fase 1 — O webhook está cadastrado no Itaú?

O **dev.itau** (UI PIX) muitas vezes **não lista** webhook de **Boletos v3**.
A fonte de verdade é a API via bridge:

```bash
curl -s "$BRIDGE_URL/v1/boleto-webhook-check?id_beneficiario=$ITAU_BENEFICIARIO_ID" \
  -H "x-bridge-token: $BRIDGE_ACCESS_TOKEN" | jq .
```

### Interpretação

| Resultado | Significado |
|-----------|-------------|
| `success: true` + `registros[]` com `webhook_url` | Cadastro existe no Itaú |
| `webhook_url` aponta para **Supabase** | Projeto B configurado |
| `webhook_url` aponta para **VPS/audit** | Só o legado recebe; B não recebe |
| `registros: []` ou HTTP 4xx | **Nada cadastrado** para esse beneficiário |
| `needs_update: true` | URL diverge do `.env` do bridge (PATCH automático no check) |

**Registro de evidência:** salvar JSON da resposta com data/hora.

Script: `./scripts/validate-itau-webhook.sh phase1`

---

## Fase 2 — Endpoints Supabase existem e estão públicos?

`verify_jwt = false` em `supabase/config.toml` para:

- `itau-webhook-token`
- `itau-boleto-webhook`
- `itau-webhook` (PIX, se usar)

### 2.1 OAuth token (simula o Itaú)

```bash
curl -s -X POST "$OAUTH_URL" \
  -H "Authorization: Basic $(printf '%s:%s' "$ITAU_WEBHOOK_CLIENT_ID" "$ITAU_WEBHOOK_CLIENT_SECRET" | base64)" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" | jq .
```

| HTTP | Body | Diagnóstico |
|------|------|-------------|
| 200 | `access_token`, `expires_in` | OAuth OK |
| 401 | `invalid_client` | Secrets Supabase ≠ credenciais no cadastro Itaú |
| 500 | `server_error` | Secrets ausentes no Supabase |

### 2.2 Notificação com token inválido (deve falhar)

```bash
curl -s -X POST "$WEBHOOK_URL" \
  -H "Authorization: Bearer token-invalido" \
  -H "Content-Type: application/json" \
  -d '{"boletos":[]}' | jq .
```

Esperado: **401** — prova que o endpoint existe e valida Bearer.

Script: `./scripts/validate-itau-webhook.sh phase2`

---

## Fase 3 — Fluxo completo simulado (sem pagamento real)

Simula o que o Itaú faz: OAuth → POST notificação.

### 3.1 Obter token

Igual Fase 2.1. Guardar `ACCESS_TOKEN`.

### 3.2 POST notificação de teste

```bash
curl -s -X POST "$WEBHOOK_URL" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "boletos": [{
      "numeroNossoNumero": "00000001",
      "tipoLiquidacao": "LIQUIDADO",
      "valorPagoTotalCobranca": "100.00"
    }]
  }' | jq .
```

| Resposta | Significado |
|----------|-------------|
| `{"received":true}` HTTP 200 | Pipeline OAuth + handler OK |
| 401 | Token HMAC inválido / secret errado / expirado |
| 200 mas sem efeito no DB | Handler OK; matching de cobrança falhou (esperado com número fake) |

### 3.3 Evidência no banco (Supabase SQL)

```sql
SELECT id, nosso_numero, status, charge_id, created_at
FROM itau_webhook_events
ORDER BY created_at DESC
LIMIT 10;
```

| Evidência | Significado |
|-----------|-------------|
| Nova linha após 3.2 | Webhook **gravou** evento |
| `status = received` + `charge_id` null | Chegou; não achou cobrança (normal com `00000001`) |
| Nenhuma linha | POST não processou DB ou função não deployada |

### 3.4 Logs Edge Functions

Supabase Dashboard → Edge Functions → `itau-boleto-webhook` / `itau-webhook-token` → Logs.

Procurar: `payload recebido`, `token inválido`, `cobrança não encontrada`.

Script: `./scripts/validate-itau-webhook.sh phase3`

---

## Fase 4 — Teste com cobrança real no banco (sem pagar)

Usar uma `charge` pendente real do ambiente de staging.

### 4.1 Coletar dados

```sql
SELECT c.id, c.provider_charge_id, c.payment_status, c.provider,
       u.itau_beneficiario_id
FROM charges c
JOIN unions u ON u.id = c.union_id
WHERE c.provider = 'itau_bolecode'
  AND c.payment_status = 'pending'
  AND c.provider_charge_id IS NOT NULL
ORDER BY c.created_at DESC
LIMIT 5;
```

Calcular `nosso_numero` esperado (mesma lógica do webhook):

- Se `provider_charge_id` tem 8 dígitos → usar esse valor no POST.
- Se é UUID/`BL...` → derivar com XOR do `charge.id` (ver `deriveNossoNumero` na Edge Function).

### 4.2 POST simulado com `numeroNossoNumero` correto

Repetir Fase 3.2 com o número certo.

### 4.3 Verificar efeito

```sql
SELECT payment_status, paid_at FROM charges WHERE id = '<charge_id>';
SELECT status, payment_status FROM appointments WHERE id = '<appointment_id>';
```

| Resultado | Próximo passo |
|-----------|----------------|
| `charges.payment_status = paid` | Handler + matching OK → problema era só Itaú não chamar ou registro |
| Evento em `itau_webhook_events` mas charge pendente | Bug de matching (`provider_charge_id` vs `nosso_numero`) |
| Nada mudou | Ver `status` do evento e logs |

---

## Fase 5 — Pagamento real (opcional, depois das fases 1–4)

Somente quando 1–4 estiverem verdes no que for possível.

1. Emitir cobrança de teste (valor mínimo).
2. Anotar `charge.id`, `provider_charge_id`, `nosso_numero` retornado na API.
3. Pagar PIX ou compensar boleto.
4. Em até ~5 min, verificar:
   - `itau_webhook_events` nova linha
   - `charges.payment_status = paid`
5. Se não chegar evento: repetir Fase 1 (cadastro Itaú) — **não é bug de frontend**.

---

## Fase 6 — Comparar audit (VPS) vs Veramo (Supabase)

| Pergunta | Como validar |
|----------|----------------|
| Itaú manda para qual URL? | Fase 1 `boleto-webhook-check` |
| VPS ainda recebe? | Logs Django / `payment_webhook_logs` no audit |
| Supabase recebe? | `itau_webhook_events` + logs Edge |
| Mesmo `id_beneficiario`? | Comparar union legado vs novo |

Se só a VPS aparece no check do Itaú → projeto B **nunca** receberá até `boleto-webhook-register`.

---

## Matriz de decisão (resumo)

```
Fase 1 vazia?     → Registrar webhook (bridge register) ANTES de mexer em código
Fase 2 OAuth 401? → Alinhar ITAU_WEBHOOK_CLIENT_* (Supabase + Itaú)
Fase 3 POST 401?  → ITAU_WEBHOOK_TOKEN_SECRET
Fase 3 POST 200, DB vazio? → Deploy / migration itau_webhook_events
Fase 4 POST 200, charge não paga? → Bug matching (provider_charge_id / nosso_numero)
Fase 5 sem evento, 1–4 OK? → Itaú não dispara ou URL errada no beneficiário
```

---

## Ordem de execução recomendada

1. Fase 0 + 1 (infra + cadastro Itaú)
2. Fase 2 + 3 (OAuth + POST simulado + SQL)
3. Fase 4 (charge real, ainda sem pagar)
4. Documentar resultados na tabela abaixo
5. **Só então** implementar correções (persistência `nosso_numero`, register, TTL token, etc.)

### Registro de resultados

| Fase | Data | Responsável | Pass/Fail | Notas |
|------|------|-------------|-----------|-------|
| 0 | | | | |
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |

---

## Próxima etapa (fora deste plano)

Após validação, tratar correções priorizadas:

1. P0 — `boleto-webhook-register` + confirmar Fase 1
2. P0 — Persistir `nosso_numero` em `charges`
3. P1 — TTL token / filtros `tipoLiquidacao`
4. P2 — Unificar ou documentar webhook PIX vs boleto

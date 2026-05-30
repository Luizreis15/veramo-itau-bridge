# Execução produção Itaú — 2026-05-30

Registro da execução do passo a passo pós-reabertura do ticket (pasta `Conexao_Itau`).

## Fase A — Certificado / OAuth

| Passo | Resultado |
|-------|-----------|
| CSR gerado (`74664a19-...`) | OK — `scripts/itau-certs/` |
| POST CSR Itaú | **HTTP 409** — certificado ainda válido; renovação não necessária agora |
| OAuth bridge (`/v1/oauth-test`) | **200** — mTLS OK |
| Client ID em produção | `74664a19-79c6-480c-b7c6-dd5164080f3b` (já no Railway) |
| Escopos no token | Inclui `boletoscash-boleto.read`, `boletoscash-notificacoesboletos-webhook.write`, `webhook.write`, `pix.read`, etc. |

Script futuro: `./scripts/renovar-certificado-itau.sh` (quando o STS permitir nova emissão).

## Fase B — Webhooks

| Passo | Resultado |
|-------|-----------|
| `validate-itau-webhook.sh phase1` | **PASS** — 2 registros (BAIXA_EFETIVA + BAIXA_OPERACIONAL), URLs Supabase corretas |
| `validate-itau-webhook.sh phase2` | **PASS** — OAuth + rejeição 401 token inválido |
| `validate-itau-webhook.sh phase3` | **PASS** — POST simulado 200 |
| `boleto-webhook-register` | **already_registered** — idempotente OK |
| PIX `webhook-register` | **HTTP 201** — base `https://secure.api.itau/pix_recebimentos/v2` |
| PIX `webhook-check` | **HTTP 200** — URL `.../itau-webhook`, chave `pix@secabc.org.br` |
| Deploy Supabase | `itau-webhook`, `itau-webhook-token`, `itau-boleto-webhook`, `create-itau-charge`, `sync-payment-status` |
| Path Itaú `/pix` | `POST .../itau-webhook/pix` → **401** (função ativa; exige `ITAU_WEBHOOK_TOKEN`) |

### Fix aplicado na bridge (local, redeploy pendente)

Default de `webhook-register` alterado de `pix/v2` → `pix_recebimentos/v2` (causa do 404 inicial).

## Fase C — Consulta / pagamento real

| Teste | Resultado |
|-------|-----------|
| `charge-status` nosso `49459455` | Ainda sem dados úteis (403/404 nos paths) — polling não substitui webhook |
| Pagamento real | **Pendente** — emitir cobrança teste e pagar PIX para validar notificação Itaú |

## URLs de produção

```
OAuth boleto:  https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook-token
POST boleto:   https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-boleto-webhook
PIX (cadastro): https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook
PIX (Itaú POST): .../itau-webhook/pix
Bridge:        https://veramo-itau-bridge-production.up.railway.app
Beneficiário:  151400969995
Chave PIX:     pix@secabc.org.br
```

## Próximos passos manuais

1. **Redeploy Railway** da bridge (fix `pix_recebimentos/v2` default) — push ou redeploy manual.
2. **Cobrança teste** no Veramo + pagamento PIX → monitorar `itau_webhook_events` e logs.
3. **Renovar certificado** quando Itaú enviar novo token temporário (antes do vencimento ~jun/2026).

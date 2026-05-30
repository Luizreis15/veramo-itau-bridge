# Checkpoint Itaú HO — 2026-05-21

Tag Git: `itau-ho-2026-05-21` (repos `veramo-itau-bridge` e `veramo`).

## Encerrado neste ponto

- Bridge Railway em produção (mTLS + OAuth + emissão + consulta)
- Webhooks boleto e PIX cadastrados e validados (fases 1–3)
- Edge Functions deployadas: `create-itau-charge`, `sync-payment-status`, `itau-webhook`, `itau-webhook-token`, `itau-boleto-webhook`
- Polling frontend ~15s + `sync-payment-status` confirma pagamento real (caso `16657087`)
- Fix detecção `Baixada` / falso `paid` em `itau-payment-status.ts`
- UI cliente sem bypass (“Pular pagamento”, confirmação manual no step 2)

## Aguardando (não bloqueia HO imediata)

- Resposta Itaú sobre webhook pós-liquidação PIX Bolecode → ver `EMAIL_ITAU_WEBHOOK.md`
- Deploy frontend Vercel (`main`) com commit de UI limpa
- Revisão das demais telas do sistema

## URLs produção

| Recurso | URL |
|---------|-----|
| Bridge | https://veramo-itau-bridge-production.up.railway.app |
| OAuth webhook | https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook-token |
| Webhook boleto | https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-boleto-webhook |
| Webhook PIX | https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook |
| Frontend 2.0 | https://sistema.veramo.com.br |

## Retomar integração Itaú quando

1. Itaú responder ao e-mail técnico, ou
2. Logs Supabase mostrarem POST em `itau-boleto-webhook` / `itau-webhook/pix` após novo pagamento teste

## Smoke pós-retomada

```bash
./scripts/validate-itau-webhook.sh phase1
./scripts/validate-itau-webhook.sh phase2
```

SQL monitoramento: `docs/TESTE_REAL_CHECKLIST.md`

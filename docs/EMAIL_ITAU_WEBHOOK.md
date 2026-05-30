# E-mail Itaú — webhook Bolecode (copiar e enviar)

**Assunto:** Webhook Bolecode (PIX + boleto) — liquidação não dispara notificação — Client ID `74664a19-79c6-480c-b7c6-dd5164080f3b`

---

Prezados,

Estamos em implantação de **Bolecode (PIX + boleto)** em produção e precisamos de apoio sobre **notificações de webhook após liquidação via PIX**.

**Cadastros realizados (validados por nós):**

| Canal | URL |
|-------|-----|
| OAuth boleto | `https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook-token` |
| POST boleto | `https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-boleto-webhook` |
| PIX (cadastro) | `https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook` |
| PIX (recebimento Itaú) | `.../itau-webhook/pix` |

- **Beneficiário:** `151400969995`
- **Chave PIX:** `pix@secabc.org.br`
- **Eventos boleto:** `BAIXA_EFETIVA` e `BAIXA_OPERACIONAL` (API `notificacoes_boletos`)
- **Webhook PIX:** registrado via `PUT .../pix_recebimentos/v2/webhook/{chave}` (HTTP 201)

**Problema:** após pagamento real via PIX em cobrança Bolecode, **não recebemos POST** nas Edge Functions (`itau-boleto-webhook` nem `itau-webhook/pix`), embora a **consulta de status** na API indique liquidação (`situacao_geral_boleto: "Baixada"`).

**Casos de teste em produção:**

1. **`nosso_numero` 16657087** — PIX liquidado em ~30/05/2026; consulta retorna **Baixada**; sem evento de webhook no horário da liquidação.
2. **`nosso_numero` 49459455** — cenário similar de teste; mesma ausência de notificação.

**O que funciona hoje:** emissão, QR PIX, consulta de status (`charge-status` / API boleto) e confirmação por polling (~15–30s após liquidação).

**Perguntas:**

1. Para **Bolecode liquidado via PIX**, qual webhook deve disparar — **BAIXA_OPERACIONAL/BAIXA_EFETIVA** (boleto) ou **PIX recebimentos** (`/pix`)?
2. Qual o **SLA típico** entre liquidação PIX e envio do webhook?
3. Podem verificar nos logs internos se houve tentativa de POST para nossas URLs nos casos acima (incluindo falhas de OAuth, timeout ou 4xx/5xx)?
4. Há **pré-requisito adicional** no cadastro Bolecode para habilitar notificação automática após PIX (além dos cadastros já feitos)?

Ficamos à disposição para enviar timestamps UTC, `txid`, payloads de emissão ou participar de call técnica.

Atenciosamente,  
[Nome]  
[Empresa / contato]

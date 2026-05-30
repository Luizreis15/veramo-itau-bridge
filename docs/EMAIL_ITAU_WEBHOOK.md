# E-mail Itaú — webhook Bolecode (copiar e enviar)

**Para:** suporte técnico / implantação Itaú (canal do ticket Bolecode)  
**Assunto:** Webhook Bolecode (PIX + boleto) — liquidação não dispara notificação — Client ID `74664a19-79c6-480c-b7c6-dd5164080f3b`

---

Prezados,

Somos a **SECABC / Veramo** e estamos em implantação de **Bolecode (PIX + boleto)** em **produção**. Solicitamos apoio sobre **notificações de webhook após liquidação via PIX**, pois a consulta de status indica pagamento, mas não recebemos POST nas URLs cadastradas.

## Cadastros realizados (validados por nós)

| Canal | URL |
|-------|-----|
| OAuth boleto | `https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook-token` |
| POST boleto | `https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-boleto-webhook` |
| PIX (cadastro) | `https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook` |
| PIX (POST Itaú) | `https://mnlulratuueetbhlywkd.supabase.co/functions/v1/itau-webhook/pix` |

**Dados do beneficiário**

- Client ID: `74664a19-79c6-480c-b7c6-dd5164080f3b`
- ID beneficiário: `151400969995`
- Chave PIX: `pix@secabc.org.br`
- Eventos boleto cadastrados: `BAIXA_EFETIVA` e `BAIXA_OPERACIONAL` (API `notificacoes_boletos`)
- Webhook PIX: registrado via `PUT .../pix_recebimentos/v2/webhook/{chave}` (HTTP 201)

Validação interna (OAuth + POST simulado + consulta cadastro): **OK**.

## Problema

Após **pagamento real via PIX** em cobrança Bolecode:

- A **consulta de status** na API retorna `situacao_geral_boleto: "Baixada"`.
- **Não recebemos POST** em `itau-boleto-webhook` nem em `itau-webhook/pix` no horário da liquidação (logs Supabase sem payload recebido).

## Casos em produção

| nosso_numero | Liquidação (UTC) | Consulta API | Webhook recebido |
|--------------|------------------|--------------|------------------|
| `16657087` | ~2026-05-30 13:36:40 | Baixada | Não |
| `49459455` | teste anterior | Baixada / liquidado | Não |

## O que funciona hoje (workaround)

Emissão Bolecode, QR PIX, linha digitável e confirmação por **consulta periódica** (~15–30s após liquidação). O fluxo operacional segue, mas dependemos de polling em vez de webhook.

## Perguntas

1. Para **Bolecode liquidado via PIX**, qual webhook deve disparar — `BAIXA_OPERACIONAL` / `BAIXA_EFETIVA` (boletos) ou **PIX recebimentos** (`/pix`)?
2. Qual o **SLA típico** entre liquidação PIX e envio do webhook?
3. Podem verificar nos logs internos se houve tentativa de POST para nossas URLs nos casos acima (incluindo falhas de OAuth, timeout ou respostas 4xx/5xx)?
4. Existe **pré-requisito adicional** no produto Bolecode para habilitar notificação automática após PIX, além dos cadastros já realizados?

Enviamos timestamps UTC, `txid`, payloads de emissão ou participamos de call técnica, se necessário.

Atenciosamente,

**[Nome]**  
**[Cargo]** — SECABC / Veramo  
**[E-mail]** | **[Telefone]**

---

## Checklist antes de enviar

- [ ] Anexar prints dos cadastros webhook (fase 1 do `validate-itau-webhook.sh`), se o canal pedir
- [ ] Confirmar e-mail/caso do ticket Itaú aberto em `Desktop/Conexao_Itau`
- [ ] Guardar cópia do enviado + data para retomar integração quando responderem

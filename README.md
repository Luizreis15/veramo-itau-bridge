# veramo-itau-bridge

Microserviço Node.js + Fastify para autenticação OAuth Itaú com mTLS real via `https.Agent`.

Existe porque Supabase Edge Runtime (Deno) não envia o client certificate corretamente para o Itaú STS — erro `C100 Ausência do certificado na chamada`.

---

## Pré-requisitos

- Node.js 20+
- Certificado e chave privada Itaú (`.crt` / `.key`)
- `ITAU_CLIENT_ID` e `ITAU_CLIENT_SECRET` do portal Itaú

---

## Setup

```bash
cd veramo-itau-bridge
npm install
cp .env.example .env
# editar .env com os valores reais
```

### Preencher `.env`

```bash
# Copiar PEM do certificado para a variável
ITAU_CERT_PEM="$(cat /caminho/para/itau_certificado.crt)"
ITAU_KEY_PEM="$(cat /caminho/para/chave_privada.key)"
```

Ou editar `.env` manualmente com o conteúdo dos arquivos.

---

## Rodar localmente

```bash
npm start
# ou com hot-reload:
npm run dev
```

---

## Endpoints

### `GET /healthz`

Verifica se o serviço está de pé. Não requer autenticação.

```bash
curl http://localhost:3001/healthz
# {"ok":true,"service":"veramo-itau-bridge"}
```

---

### `POST /v1/oauth-test`

Replica `bolecode_service.py get_access_token()` com mTLS real.

**Autenticação:** header `x-bridge-token: <BRIDGE_ACCESS_TOKEN>`

```bash
curl -s -X POST http://localhost:3001/v1/oauth-test \
  -H "x-bridge-token: SEU_BRIDGE_ACCESS_TOKEN" \
  | jq
```

**Resposta esperada (sucesso):**
```json
{
  "success": true,
  "status_code": 200,
  "token_url": "https://sts.itau.com.br/api/oauth/token",
  "mtls_used": true,
  "headers_sent": ["Content-Type"],
  "body_keys_sent": ["grant_type", "client_id", "client_secret"],
  "response_body": {
    "access_token": "****",
    "token_type": "Bearer",
    "expires_in": 3600
  },
  "latency_ms": 312
}
```

**Diagnósticos pelo `status_code`:**
| status_code | Significado |
|---|---|
| `200` | OAuth ok — mTLS funcionando |
| `403` | Credenciais recusadas (client_id/secret errados) |
| `null` + erro mTLS | Client certificate rejeitado |
| `null` + rede | Endpoint inacessível |

---

## `POST /v1/boleto-baixa`

Baixa (cancela) boleto não pago no Itaú. Ver `veramo/docs/ITAU-BOLETO-BAIXA.md`.

```bash
curl -sS -X POST http://localhost:3001/v1/boleto-baixa \
  -H "x-bridge-token: $BRIDGE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"beneficiario_id":"…","nosso_numero":"12345678","id_boleto":"…"}'
```

---

## Fase seguinte

Após `/v1/oauth-test` retornar `success: true`, implementar `/v1/charges` para criação de Bolecode real.

# Passo a passo — testar se o webhook existe

Siga na ordem. Cada passo tem **um comando** no terminal.

---

## Passo 1 — Abrir o terminal na pasta certa

```bash
cd /Users/samiragouvea/veramo-itau-bridge
```

---

## Passo 2 — Criar o arquivo com seus dados

```bash
cp scripts/validate.env.example scripts/validate.env
```

Abra o arquivo `scripts/validate.env` no editor e troque **cada** linha pelos valores reais:

| Linha no arquivo | Onde pegar o valor |
|------------------|-------------------|
| `BRIDGE_URL` | URL do bridge em produção (ex: `https://veramo-itau-bridge-xxxx.railway.app`) |
| `BRIDGE_ACCESS_TOKEN` | Mesmo valor de `BRIDGE_ACCESS_TOKEN` no `.env` do bridge |
| `ITAU_BENEFICIARIO_ID` | Supabase → tabela `unions` → coluna `itau_beneficiario_id` |
| `SUPABASE_PROJECT_REF` | Deixe `mnlulratuueetbhlywkd` se for esse o projeto |
| `ITAU_WEBHOOK_CLIENT_ID` | Supabase → Project Settings → Edge Functions → Secrets |
| `ITAU_WEBHOOK_CLIENT_SECRET` | Idem |

Salve o arquivo.

---

## Passo 3 — Conferir o arquivo `validate.env`

Cada linha deve começar com **`export`** (exemplo: `export BRIDGE_URL=https://...`).

O script carrega esse arquivo sozinho. Opcional:

```bash
source scripts/validate.env
```

---

## Passo 4 — Teste A: bridge está no ar?

```bash
curl -s "${BRIDGE_URL%/}/healthz"
```

**Esperado:** aparece algo como `{"ok":true,"service":"veramo-itau-bridge"}`

Se der erro de conexão, pare aqui e corrija `BRIDGE_URL`.

---

## Passo 5 — Teste B: o Itaú tem webhook cadastrado?

Este é o teste principal. O dev.itau **não** mostra isso; consultamos pela API:

```bash
./scripts/validate-itau-webhook.sh phase1
```

(Não precisa rodar `source` antes — o script lê `scripts/validate.env` automaticamente.)

**Leia o resultado:**

- Se aparecer `webhook_url: https://....supabase.co/functions/v1/itau-boleto-webhook`  
  → Webhook **existe** e aponta para o projeto novo.

- Se aparecer `webhook_url` com domínio da VPS (Hostinger)  
  → Webhook existe mas o Itaú manda para o **sistema antigo**, não para o Supabase.

- Se aparecer `registros vazios` ou lista vazia  
  → Webhook **não está cadastrado** no Itaú para esse beneficiário.

Copie a saída inteira e guarde.

---

## Passo 6 — Teste C: endpoints do Supabase respondem?

```bash
./scripts/validate-itau-webhook.sh phase0
```

**Esperado:** linhas com `✓ PASS` (pode mostrar HTTP 401 — isso é normal sem senha).

---

## Passo 7 — Teste D: OAuth do webhook funciona?

Só rode se preencheu `ITAU_WEBHOOK_CLIENT_ID` e `ITAU_WEBHOOK_CLIENT_SECRET` no `validate.env`:

```bash
source scripts/validate.env
./scripts/validate-itau-webhook.sh phase2
```

**Esperado:** `✓ PASS OAuth token obtido (HTTP 200)`

Se der `FAIL OAuth`, os secrets do Supabase não batem com o que está cadastrado no Itaú.

---

## Passo 8 — Teste E: simular o Itaú enviando pagamento

```bash
source scripts/validate.env
./scripts/validate-itau-webhook.sh phase3
```

**Esperado:** `✓ PASS Webhook aceitou notificação simulada`

---

## Passo 9 — Teste F: conferir no banco (navegador)

1. Abra https://supabase.com/dashboard  
2. Projeto Veramo → **SQL Editor**  
3. Cole e execute:

```sql
SELECT id, nosso_numero, status, charge_id, created_at
FROM itau_webhook_events
ORDER BY created_at DESC
LIMIT 5;
```

**Esperado após o Passo 8:** aparece **uma linha nova** com `nosso_numero = 00000001`.

Se não aparecer nada, o webhook não gravou no banco (problema de deploy ou função).

---

## Passo 10 — Me envie isto

Copie e cole na conversa:

1. Saída completa do **Passo 5** (`phase1`)
2. Se rodou: Passo 7 e 8 (últimas 20 linhas)
3. Resultado do SQL do **Passo 9** (print ou texto)

Com isso dizemos o próximo fix exato.

---

## Erros comuns

**`cd: no such file or directory: veramo-itau-bridge`**  
Você já está dentro da pasta. Use só:
```bash
cd /Users/samiragouvea/veramo-itau-bridge
```

**`export: not valid in this context`**  
Não cole linhas com `# comentário` no meio do `export`. Use o arquivo `validate.env` e `source scripts/validate.env`.

**`jq: command not found`**  
```bash
brew install jq
```

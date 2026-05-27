/**
 * itau-webhook-token — OAuth2 token endpoint para autenticação do webhook Itaú Boletos v3
 *
 * O Itaú chama este endpoint ANTES de enviar uma notificação, usando:
 *   Authorization: Basic base64(ITAU_WEBHOOK_CLIENT_ID:ITAU_WEBHOOK_CLIENT_SECRET)
 *   Body: grant_type=client_credentials
 *
 * Retorna um Bearer token assinado com HMAC-SHA256 que a função itau-boleto-webhook valida.
 *
 * Secrets necessários (configurar no Supabase Dashboard → Edge Functions → Secrets):
 *   ITAU_WEBHOOK_CLIENT_ID      — client_id que você informa no portal Itaú ao registrar o webhook
 *   ITAU_WEBHOOK_CLIENT_SECRET  — client_secret correspondente
 *   ITAU_WEBHOOK_TOKEN_SECRET   — segredo aleatório para assinar os tokens (mín. 32 chars)
 */

const TOKEN_TTL_SECONDS = 300

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function hmacSign(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const clientId    = Deno.env.get('ITAU_WEBHOOK_CLIENT_ID')
  const clientSec   = Deno.env.get('ITAU_WEBHOOK_CLIENT_SECRET')
  const tokenSecret = Deno.env.get('ITAU_WEBHOOK_TOKEN_SECRET')

  if (!clientId || !clientSec || !tokenSecret) {
    console.error('[itau-webhook-token] secrets ausentes')
    return json({ error: 'server_error' }, 500)
  }

  // ── Validar Basic Auth ────────────────────────────────────────────────────
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Basic ')) {
    console.warn('[itau-webhook-token] Authorization ausente ou não é Basic')
    return json({ error: 'invalid_client' }, 401)
  }

  let incomingId: string, incomingSecret: string
  try {
    const decoded  = atob(auth.slice(6).trim())
    const sep      = decoded.indexOf(':')
    if (sep < 0) throw new Error('sem separador')
    incomingId     = decoded.slice(0, sep)
    incomingSecret = decoded.slice(sep + 1)
  } catch {
    console.warn('[itau-webhook-token] falha ao decodificar Basic Auth base64')
    return json({ error: 'invalid_client' }, 401)
  }

  // trim() defensivo — secrets do Supabase às vezes chegam com \n no final
  const expectedId  = clientId.trim()
  const expectedSec = clientSec.trim()
  const receivedId  = incomingId.trim()
  const receivedSec = incomingSecret.trim()

  if (receivedId !== expectedId || receivedSec !== expectedSec) {
    console.warn('[itau-webhook-token] credenciais inválidas')
    return json({ error: 'invalid_client' }, 401)
  }

  // ── Validar grant_type (form-encoded ou JSON) ─────────────────────────────
  let grantType = ''
  const ct = req.headers.get('Content-Type') ?? ''
  if (ct.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(await req.text())
    grantType    = params.get('grant_type') ?? ''
  } else {
    try { grantType = ((await req.json()) as Record<string, string>).grant_type ?? '' } catch { /* ok */ }
  }

  if (grantType !== 'client_credentials') {
    return json({ error: 'unsupported_grant_type' }, 400)
  }

  // ── Gerar token: base64url(payload).signature ─────────────────────────────
  const now        = Math.floor(Date.now() / 1000)
  const payloadObj = { iss: 'veramo-boleto', iat: now, exp: now + TOKEN_TTL_SECONDS }
  const payloadB64 = btoa(JSON.stringify(payloadObj))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
  const signature  = await hmacSign(payloadB64, tokenSecret)
  const accessToken = `${payloadB64}.${signature}`

  console.log('[itau-webhook-token] token gerado para client_id:', incomingId)

  return json({
    access_token: accessToken,
    token_type:   'Bearer',
    expires_in:   TOKEN_TTL_SECONDS,
    scope:        'boletowebhook',
  })
})

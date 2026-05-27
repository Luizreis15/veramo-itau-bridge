import { triggerMeetIfReady } from '../_shared/trigger-meet-if-ready.ts'

/**
 * itau-boleto-webhook — Recebe notificações de pagamento de boleto da API Boletos v3 do Itaú
 *
 * Fluxo:
 *   Boleto pago → Itaú chama itau-webhook-token (OAuth2) → obtém Bearer token
 *               → Itaú chama este endpoint com Authorization: Bearer <token>
 *               → Validamos o token, identificamos a cobrança pelo nosso_numero
 *               → Atualizamos charges.payment_status = 'paid' e appointment
 *
 * Registro no portal Itaú (API Boletos v3 → POST /notificacoes_boletos):
 *   webhook_url       → https://<project>.supabase.co/functions/v1/itau-boleto-webhook
 *   webhook_oauth_url → https://<project>.supabase.co/functions/v1/itau-webhook-token
 *   webhook_oauth_scope → boletowebhook
 *   valor_minimo      → 0.01
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// Determinístico: mesmo charge_id sempre gera o mesmo nosso_numero
function deriveNossoNumero(chargeId: string): string {
  const hex   = chargeId.replace(/-/g, '')
  const parts = [
    parseInt(hex.slice(0,  8), 16),
    parseInt(hex.slice(8,  16), 16),
    parseInt(hex.slice(16, 24), 16),
    parseInt(hex.slice(24, 32), 16),
  ]
  const combined = parts.reduce((acc: number, v: number) => acc ^ v, 0)
  return String(Math.abs(combined) % 100_000_000).padStart(8, '0')
}

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

async function validateBearerToken(token: string, secret: string): Promise<boolean> {
  try {
    const dot = token.indexOf('.')
    if (dot < 0) {
      console.warn('[itau-boleto-webhook] token sem separador "."')
      return false
    }
    const payloadB64 = token.slice(0, dot)
    const signature  = token.slice(dot + 1)

    const expected = await hmacSign(payloadB64, secret)
    if (expected !== signature) {
      console.warn('[itau-boleto-webhook] assinatura HMAC não confere', {
        expected_length: expected.length,
        received_length: signature.length,
        secret_length:   secret.length,
      })
      return false
    }

    // Padding correto: (4 - len%4) % 4 — evita erro com base64url sem padding
    const b64std  = payloadB64.replace(/-/g, '+').replace(/_/g, '/')
    const padding = (4 - (b64std.length % 4)) % 4
    const payloadJson = atob(b64std + '='.repeat(padding))
    const payload = JSON.parse(payloadJson) as { exp?: number; iat?: number }

    const now = Math.floor(Date.now() / 1000)
    if (payload.exp && payload.exp < now) {
      console.warn('[itau-boleto-webhook] token expirado', {
        exp: payload.exp,
        now,
        diff_seconds: now - payload.exp,
      })
      return false
    }

    return true
  } catch (err) {
    console.warn('[itau-boleto-webhook] exceção na validação do token:', err instanceof Error ? err.message : String(err))
    return false
  }
}

// Situações que indicam pagamento efetivo (liquidação)
// '95' = Liquidação em cartório (código real da API Boletos v3 do Itaú)
const PAID_SITUATIONS = [
  'LIQUIDADO', 'LIQUIDACAO', 'PAGO', 'BAIXADO', 'BAIXA_EFETIVA', 'BAIXA_OPERACIONAL', 'CONCLUIDA', '06', '17', '95',
]

function extractPaymentData(raw: Record<string, unknown>): {
  nossoNumero: string | null
  isPaid:      boolean
  valorPago:   number
  dataPago:    string | null
} {
  const d = (raw.data as Record<string, unknown> | undefined) ?? raw

  // Estrutura array boletos[] — formato real do webhook Itaú Boletos v3
  // { boletos: [{ numeroNossoNumero, tipoLiquidacao, valorPagoTotalCobranca }] }
  const boletosArr = (raw.boletos ?? d.boletos) as Array<Record<string, unknown>> | undefined
  const boletoItem = boletosArr?.[0] ?? {}

  // Estrutura aninhada alternativa: dado_boleto.dados_individuais_boleto[0]
  const dadoBoleto  = (d.dado_boleto as Record<string, unknown> | undefined)
  const individuais = (dadoBoleto?.dados_individuais_boleto as Array<Record<string, unknown>> | undefined) ?? []
  const individual  = individuais[0] ?? {}

  const nossoNumero = (
    boletoItem.numeroNossoNumero ??
    individual.nosso_numero ??
    d.nosso_numero ?? d.id_boleto ?? d.codigo_barras ??
    raw.nosso_numero ?? raw.id_boleto
  ) as string | null ?? null

  const situacao = String(
    boletoItem.tipoLiquidacao ??
    individual.situacao_boleto ?? individual.situacao ??
    d.situacao ?? d.status ?? d.tipo_ocorrencia ?? d.tipo_baixa ??
    raw.situacao ?? raw.tipo_ocorrencia ?? ''
  ).toUpperCase()

  // situacao === '' significa que o campo não foi encontrado — não confirmar pagamento
  const isPaid = situacao !== '' && PAID_SITUATIONS.some(s => situacao.includes(s))

  const valorPago = Number(
    boletoItem.valorPagoTotalCobranca ??
    d.valor_pago ?? d.valor_pagamento ?? d.valor ??
    raw.valor_pago ?? 0
  )

  const dataPago = (
    boletoItem.dataNotificacao ??
    d.data_liquidacao ?? d.data_pagamento ?? d.data_ocorrencia ??
    raw.data_liquidacao
  ) as string | null ?? null

  return { nossoNumero, isPaid, valorPago, dataPago }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200 })
  if (req.method !== 'POST')   return json({ error: 'Método não permitido.' }, 405)

  try {
    return await handle(req)
  } catch (err) {
    console.error('[itau-boleto-webhook] erro interno:', err instanceof Error ? err.message : String(err))
    return json({ received: true })
  }
})

async function handle(req: Request): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const tokenSecret = Deno.env.get('ITAU_WEBHOOK_TOKEN_SECRET')

  if (!supabaseUrl || !serviceKey || !tokenSecret) {
    return json({ error: 'Configuração ausente.' }, 500)
  }

  // ── Validar Bearer token (rápido, sem DB) ─────────────────────────────────
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) {
    console.warn('[itau-boleto-webhook] Authorization ausente ou inválido')
    return json({ error: 'Token inválido.' }, 401)
  }

  const isValid = await validateBearerToken(auth.slice(7), tokenSecret)
  if (!isValid) {
    console.warn('[itau-boleto-webhook] token inválido ou expirado')
    return json({ error: 'Token inválido.' }, 401)
  }

  // ── Parsear body ──────────────────────────────────────────────────────────
  let payload: Record<string, unknown>
  try { payload = await req.json() } catch { return json({ error: 'Body inválido.' }, 400) }

  console.log('[itau-boleto-webhook] payload recebido:', JSON.stringify(payload))

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  // Responde 200 imediatamente; todo o processamento de DB acontece em background
  // @ts-ignore — disponível em Supabase Edge Runtime
  EdgeRuntime.waitUntil(processAsync(admin, payload, tokenSecret))

  return json({ received: true })
}

async function processAsync(
  admin:        ReturnType<typeof createClient>,
  payload:      Record<string, unknown>,
  _tokenSecret: string,
): Promise<void> {
  try {
    const { nossoNumero, isPaid, valorPago, dataPago } = extractPaymentData(payload)

    // ── Salvar evento bruto antes de qualquer processamento ──────────────────
    const { data: webhookEvent } = await admin.from('itau_webhook_events').insert({
      event_type:   isPaid ? 'liquidacao' : 'outro',
      nosso_numero: nossoNumero,
      amount:       valorPago || null,
      status:       'received',
      raw_payload:  payload,
    }).select('id').maybeSingle()

    const eventId = webhookEvent?.id ?? null

    if (!nossoNumero) {
      console.warn('[itau-boleto-webhook] nosso_numero não identificado no payload')
      return
    }

    if (!isPaid) {
      console.log('[itau-boleto-webhook] evento não é liquidação — ignorando')
      return
    }

    // ── Buscar cobrança pelo nosso_numero ────────────────────────────────────

    let charge: { id: string; appointment_id: string; payment_status: string } | null = null

    // Caso 1: coluna dedicada (pós-migration 20260521120000)
    const { data: byNossoNumero } = await admin
      .from('charges')
      .select('id, appointment_id, payment_status')
      .eq('nosso_numero', nossoNumero)
      .maybeSingle()
    charge = byNossoNumero ?? null
    if (charge) console.log('[itau-boleto-webhook] cobrança encontrada por charges.nosso_numero')

    // Caso 2: legado — nosso_numero guardado em provider_charge_id (HTTP 202)
    if (!charge) {
      const { data: byProvId } = await admin
        .from('charges')
        .select('id, appointment_id, payment_status')
        .eq('provider_charge_id', nossoNumero)
        .maybeSingle()
      charge = byProvId ?? null
      if (charge) console.log('[itau-boleto-webhook] cobrança encontrada por provider_charge_id')
    }

    // Caso 3: fallback — derivação determinística do charge.id (cobranças antigas)
    if (!charge) {
      const { data: candidates } = await admin
        .from('charges')
        .select('id, appointment_id, payment_status')
        .eq('provider', 'itau_bolecode')
        .neq('payment_status', 'paid')
      charge = candidates?.find(c => deriveNossoNumero(c.id) === nossoNumero) ?? null
      if (charge) console.log('[itau-boleto-webhook] cobrança encontrada por derivação de nosso_numero')
    }

    if (!charge) {
      console.warn('[itau-boleto-webhook] cobrança não encontrada para nosso_numero:', nossoNumero)
      return
    }

    // ── Atualizar evento com charge_id encontrado ────────────────────────────
    if (eventId) {
      await admin.from('itau_webhook_events')
        .update({ charge_id: charge.id, status: 'matched' })
        .eq('id', eventId)
    }

    // ── Idempotência ──────────────────────────────────────────────────────────
    if (charge.payment_status === 'paid') {
      console.log('[itau-boleto-webhook] charge', charge.id, 'já está pago — ignorando')
      if (eventId) await admin.from('itau_webhook_events')
        .update({ status: 'duplicate', processed_at: new Date().toISOString() })
        .eq('id', eventId)
      return
    }

    // ── Confirmar pagamento ───────────────────────────────────────────────────
    await admin.from('charges')
      .update({ payment_status: 'paid', paid_at: dataPago ?? new Date().toISOString() })
      .eq('id', charge.id)

    await admin.from('appointments')
      .update({ payment_status: 'paid', status: 'payment_confirmed' })
      .eq('id', charge.appointment_id)

    await admin.from('payment_transactions').insert({
      charge_id:               charge.id,
      provider_transaction_id: nossoNumero,
      status:                  'paid',
      amount:                  valorPago,
      raw_payload:             payload,
    })

    if (eventId) await admin.from('itau_webhook_events')
      .update({ status: 'processed', processed_at: new Date().toISOString() })
      .eq('id', eventId)

    console.log('[itau-boleto-webhook] charge', charge.id, 'confirmado pago. nosso_numero:', nossoNumero)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (supabaseUrl && serviceKey && charge.appointment_id) {
      triggerMeetIfReady(supabaseUrl, serviceKey, charge.appointment_id)
        .catch(e => console.warn('[itau-boleto-webhook] meet:', e))
    }
  } catch (err) {
    console.error('[itau-boleto-webhook] erro no processamento async:', err instanceof Error ? err.message : String(err))
  }
}

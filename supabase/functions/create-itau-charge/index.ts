/**
 * create-itau-charge — Fase 4: roteamento via veramo-itau-bridge
 *
 * Comportamento controlado por secret:
 *   ITAU_REAL_CHARGE_ENABLED=false (padrão) → mock, sem chamada ao bridge
 *   ITAU_REAL_CHARGE_ENABLED=true           → POST /v1/charges no bridge
 *
 * Fluxo real:
 *   Edge Function → BRIDGE_URL/v1/charges → Itaú Bolecode API
 *
 * O bridge (veramo-itau-bridge) gerencia OAuth + mTLS com https.Agent (Node.js),
 * pois Supabase Edge Runtime (Deno) não envia client certificate corretamente.
 *
 * O que esta função FAZ:
 *   - Valida cobrança e acesso do chamador
 *   - Roteia entre mock e bridge via ITAU_REAL_CHARGE_ENABLED
 *   - Atualiza charges (provider_charge_id, pix, boleto_url, payment_status)
 *   - Persiste raw_response em payment_transactions
 *   - Avança appointment para awaiting_payment se ainda em draft
 *
 * O que esta função NÃO FAZ:
 *   - Não faz chamadas mTLS diretas (delegado ao bridge)
 *   - Não loga access_token, certificados ou secrets
 *   - Não altera cobranças Asaas
 *   - Não processa webhooks
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { requireUser } from '../_shared/auth.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { logEvent } from '../_shared/structured-log.ts'

const FN = 'create-itau-charge'
import { sanitizeLog } from '../_shared/itau-provider.ts'
import {
  validateUnionItauConfig,
  validateCompanyAddress,
  generateNossoNumero,
  resolvePixTransactionId,
  type CompanyContext,
  type UnionItauContext,
} from '../_shared/itau-bolecode-mapper.ts'

// ── Tipos internos ────────────────────────────────────────────────────────────

/** Resultado normalizado — mesmo shape para mock e bridge real */
type ChargePayload = {
  providerChargeId: string
  nossoNumero:      string
  txid:             string | null
  pixCopyPaste:     string | null
  pixQrCode:        string | null
  boletoUrl:        string | null
  rawPayload:       Record<string, unknown>
  isMock:           boolean
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type JsonFn = (body: unknown, status?: number) => Response

function dueDateFor(billingType: 'PIX' | 'BOLETO'): string {
  const d = new Date()
  d.setDate(d.getDate() + (billingType === 'BOLETO' ? 5 : 1))
  return d.toISOString().split('T')[0]
}

// ── Mock (mantido intacto) ────────────────────────────────────────────────────

function generateMockPayload(
  chargeId:    string,
  billingType: 'PIX' | 'BOLETO',
  dueDate:     string,
  amount:      number,
): ChargePayload {
  const timestamp   = Date.now()
  const rand        = Math.random().toString(36).slice(2, 10).toUpperCase()
  const nossoNumero = String(timestamp).slice(-8)
  const txid        = `${rand}${String(timestamp)}`.slice(0, 32).padEnd(32, '0')
  const providerChargeId = `ITAU-MOCK-${nossoNumero}-${rand}`

  // Bolecode: BOLETO inclui linha + PIX no mesmo payload
  const pixCopyPaste = billingType === 'PIX' || billingType === 'BOLETO'
    ? `MOCK:ITAU:PIX:${txid}:AMT:${amount.toFixed(2)}:DUE:${dueDate}`
    : null

  const boletoUrl = billingType === 'BOLETO'
    ? `MOCK.${nossoNumero} LINHA.DIGITAVEL.FAKE ${dueDate}`
    : null

  return {
    providerChargeId,
    nossoNumero,
    txid,
    pixCopyPaste,
    pixQrCode:  null,
    boletoUrl,
    isMock:     true,
    rawPayload: {
      mock:             true,
      provider:         'itau_bolecode',
      charge_id:        chargeId,
      billing_type:     billingType,
      nosso_numero:     nossoNumero,
      txid,
      due_date:         dueDate,
      valor:            amount,
      linha_digitavel:  billingType === 'BOLETO' ? `MOCK.${nossoNumero} LINHA.DIGITAVEL.FAKE ${dueDate}` : null,
      codigo_de_barras: billingType === 'BOLETO' ? `00190.00009 ${nossoNumero}.000000 0 00000 ${String(amount * 100).padStart(10, '0')}` : null,
      url_boleto:       boletoUrl,
      emv_payload:      pixCopyPaste,
      qr_code_base64:   null,
    },
  }
}

// ── Chamada real via bridge ───────────────────────────────────────────────────

type RealCallResult =
  | { ok: true;  payload: ChargePayload }
  | { ok: false; error: string; httpStatus: number }

async function callItauViaBridge(
  admin:       SupabaseClient,
  charge:      { id: string; gross_amount: number; union_id: string; company_id: string; appointment_id: string },
  billingType: 'PIX' | 'BOLETO',
  dueDate:     string,
): Promise<RealCallResult> {

  // ── 1. Secrets do bridge ────────────────────────────────────────────────
  const bridgeUrl   = Deno.env.get('BRIDGE_URL')
  const bridgeToken = Deno.env.get('BRIDGE_ACCESS_TOKEN')

  if (!bridgeUrl || !bridgeToken) {
    return { ok: false, error: 'BRIDGE_URL ou BRIDGE_ACCESS_TOKEN não configurados.', httpStatus: 500 }
  }

  // ── 2. Configuração Itaú do sindicato ───────────────────────────────────
  const { data: union, error: unionErr } = await admin
    .from('unions')
    .select('itau_beneficiario_id, itau_pix_key, itau_carteira_code')
    .eq('id', charge.union_id)
    .maybeSingle()

  if (unionErr || !union) {
    return { ok: false, error: 'Sindicato não encontrado.', httpStatus: 404 }
  }

  const unionErrors = validateUnionItauConfig(union as Partial<UnionItauContext>)
  if (unionErrors.length > 0) {
    const detail = unionErrors.map(e => e.message).join(' ')
    return { ok: false, error: `Sindicato sem configuração Itaú completa: ${detail}`, httpStatus: 422 }
  }

  // ── 3. Dados da empresa ─────────────────────────────────────────────────
  const { data: company, error: companyErr } = await admin
    .from('companies')
    .select('legal_name, cnpj, address_line, address_number, neighborhood, city, state, zip_code')
    .eq('id', charge.company_id)
    .maybeSingle()

  if (companyErr || !company) {
    return { ok: false, error: 'Empresa não encontrada.', httpStatus: 404 }
  }

  const companyErrors = validateCompanyAddress(company as CompanyContext)
  if (companyErrors.length > 0) {
    const detail = companyErrors.map(e => `${e.field}: ${e.message}`).join(' ')
    return { ok: false, error: `Endereço da empresa inválido: ${detail}`, httpStatus: 422 }
  }

  // ── 4. Dados do agendamento ─────────────────────────────────────────────
  const { data: appointment, error: appointmentErr } = await admin
    .from('appointments')
    .select('id, protocol, employee_name')
    .eq('id', charge.appointment_id)
    .maybeSingle()

  if (appointmentErr || !appointment) {
    return { ok: false, error: 'Agendamento não encontrado.', httpStatus: 404 }
  }

  // ── 5. Montar request para o bridge ────────────────────────────────────
  const nossoNumero = generateNossoNumero(charge.id)
  const cep         = (company.zip_code ?? '').replace(/\D/g, '').padEnd(8, '0').slice(0, 8)
  const logradouro  = [company.address_line, company.address_number].filter(Boolean).join(', ') || 'NAO INFORMADO'

  const bridgeBody = {
    amount:         charge.gross_amount,
    due_date:       dueDate,
    nosso_numero:   nossoNumero,
    correlation_id: charge.id,
    payer: {
      nome:        company.legal_name,
      tipo_pessoa: 'J',
      cnpj:        company.cnpj,
      endereco: {
        logradouro,
        bairro: company.neighborhood ?? 'Centro',
        cidade: company.city         ?? 'Sao Paulo',
        uf:     (company.state       ?? 'SP').slice(0, 2).toUpperCase(),
        cep,
      },
    },
    beneficiario_id: (union as UnionItauContext).itau_beneficiario_id,
    pix_key:         (union as UnionItauContext).itau_pix_key,
    carteira_code:   (union as UnionItauContext).itau_carteira_code,
    texto_ref:       (appointment.protocol ?? charge.id).slice(0, 6),
    mensagem:        `Homologacao Trabalhista ${appointment.protocol}`,
  }

  console.log(
    '[create-itau-charge] chamando bridge — charge:', sanitizeLog(charge.id),
    '| nosso_numero:', nossoNumero,
    '| billing_type:', billingType,
  )

  // ── 6. POST ao bridge ───────────────────────────────────────────────────
  let bridgeRes: Response
  try {
    bridgeRes = await fetch(`${bridgeUrl.replace(/\/$/, '')}/v1/charges`, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'x-bridge-token': bridgeToken,
      },
      body: JSON.stringify(bridgeBody),
    })
  } catch {
    return { ok: false, error: 'Bridge inacessível — verifique BRIDGE_URL e conectividade.', httpStatus: 502 }
  }

  // ── 7. Processar resposta do bridge ─────────────────────────────────────
  let bridgeData: Record<string, unknown>
  try {
    bridgeData = await bridgeRes.json()
  } catch {
    return { ok: false, error: 'Bridge retornou resposta não JSON.', httpStatus: 502 }
  }

  if (!bridgeRes.ok || bridgeData.success !== true) {
    const errMsg = typeof bridgeData.error === 'string'
      ? bridgeData.error
      : `Bridge retornou HTTP ${bridgeRes.status}`
    return { ok: false, error: errMsg, httpStatus: bridgeRes.status >= 500 ? 502 : 422 }
  }

  // ── 8. HTTP 202 — processamento assíncrono ──────────────────────────────
  // Bolecode registrado no Itaú mas sem dados de pagamento ainda.
  // O webhook atualizará charges quando o Itaú confirmar.
  if (bridgeData.status === 'processing') {
    return {
      ok: true,
      payload: {
        providerChargeId: nossoNumero,
        nossoNumero,
        txid:         null,
        pixCopyPaste: null,
        pixQrCode:    null,
        boletoUrl:    null,
        isMock:       false,
        rawPayload:   bridgeData,
      },
    }
  }

  // ── 9. Resposta síncrona com dados do Bolecode ──────────────────────────
  const providerChargeId = (bridgeData.provider_charge_id as string | null) ?? nossoNumero
  const itauNossoNumero  = (bridgeData.nosso_numero as string | null) ?? nossoNumero
  const pixCopyPaste     = (bridgeData.pix_copy_paste as string | null) ?? null
  const pixTxid          = resolvePixTransactionId(pixCopyPaste, (bridgeData.txid as string | null) ?? null)

  console.log(
    '[create-itau-charge] Bolecode criado via bridge — nosso_numero:', itauNossoNumero,
    '| txid:', pixTxid ? sanitizeLog(pixTxid) : 'n/a',
  )

  return {
    ok: true,
    payload: {
      providerChargeId,
      nossoNumero:  itauNossoNumero,
      txid:         pixTxid,
      pixCopyPaste,
      pixQrCode:    (bridgeData.pix_qr_code    as string | null) ?? null,
      boletoUrl:    (bridgeData.boleto_url     as string | null) ?? null,
      isMock:       false,
      rawPayload:   bridgeData,
    },
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const CORS = corsHeaders(req)
  const json: JsonFn = (body, status = 200) => {
    const payload = typeof body === 'object' && body !== null
      ? { message: (body as { error?: string }).error ?? (body as { message?: string }).message, ...body }
      : body
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    })
  }

  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  if (req.method !== 'POST')   return json({ error: 'Método não permitido.' }, 405)

  try {
    return await handle(req, json, CORS)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[create-itau-charge] erro não tratado:', msg)
    return json({ error: `Erro interno: ${msg}`, message: `Erro interno: ${msg}` }, 500)
  }
})

async function handle(req: Request, json: JsonFn, CORS: Record<string, string>): Promise<Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !serviceKey) {
    return json({ error: 'Configuração ausente.' }, 500)
  }

  // Flag de segurança — false por padrão, nunca ativa sem configuração explícita
  const isRealEnabled = Deno.env.get('ITAU_REAL_CHARGE_ENABLED') === 'true'

  /* ── 1. Autenticação ── */
  const auth = await requireUser(req, CORS)
  if (auth instanceof Response) return auth
  const userId = auth.user.id

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  /* ── 2. Papel do chamador ── */
  const { data: caller, error: callerErr } = await admin
    .from('profiles')
    .select('role, company_id, office_id, union_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (callerErr || !caller) return json({ error: 'Perfil não encontrado.' }, 403)

  const isCompanyRole = ['company_master', 'company_user'].includes(caller.role)
  const isOfficeRole  = ['office_master', 'office_user'].includes(caller.role)
  const isUnionMaster = caller.role === 'union_master'

  if (!isCompanyRole && !isOfficeRole && !isUnionMaster) {
    return json({ error: 'Acesso negado.' }, 403)
  }

  /* ── 3. Body ── */
  let body: { charge_id: string; billing_type: 'PIX' | 'BOLETO' }
  try { body = await req.json() } catch { return json({ error: 'Body JSON inválido.' }, 400) }

  const { charge_id, billing_type } = body ?? {}
  if (!charge_id) return json({ error: 'charge_id é obrigatório.' }, 400)
  if (!billing_type || !['PIX', 'BOLETO'].includes(billing_type)) {
    return json({ error: 'billing_type deve ser PIX ou BOLETO.' }, 400)
  }

  /* ── 4. Buscar e validar cobrança ── */
  const { data: charge, error: chargeErr } = await admin
    .from('charges')
    .select('id, appointment_id, company_id, office_id, union_id, gross_amount, payment_status, provider, provider_charge_id')
    .eq('id', charge_id)
    .maybeSingle()

  if (chargeErr || !charge) return json({ error: 'Cobrança não encontrada.' }, 404)

  if (charge.provider !== 'itau_bolecode') {
    return json({
      error: `Esta cobrança usa o provider '${charge.provider}'. Use create-asaas-charge para cobranças Asaas.`,
    }, 409)
  }

  if (charge.payment_status === 'paid') {
    return json({ error: 'Esta cobrança já foi paga.' }, 409)
  }
  if (charge.provider_charge_id) {
    return json({ error: 'Cobrança Itaú já gerada. Consulte os dados existentes.' }, 409)
  }
  if (charge.gross_amount <= 0) {
    return json({ error: 'Valor da cobrança inválido.' }, 400)
  }

  /* ── 5. Validar acesso do chamador à cobrança ── */
  if (isUnionMaster) {
    if (!caller.union_id || charge.union_id !== caller.union_id) {
      return json({ error: 'Acesso negado a esta cobrança.' }, 403)
    }
  } else if (isCompanyRole && charge.company_id !== caller.company_id) {
    return json({ error: 'Acesso negado.' }, 403)
  } else if (isOfficeRole && charge.office_id !== caller.office_id) {
    return json({ error: 'Acesso negado.' }, 403)
  }

  /* ── 6. Gerar payload (mock ou bridge real) ── */
  const dueDate = dueDateFor(billing_type)
  let payload: ChargePayload

  if (!isRealEnabled) {
    payload = generateMockPayload(charge.id, billing_type, dueDate, charge.gross_amount)
    console.log('[create-itau-charge] modo mock — charge:', charge.id, '| nosso_numero:', payload.nossoNumero)
  } else {
    const result = await callItauViaBridge(admin, charge, billing_type, dueDate)
    if (!result.ok) {
      console.error('[create-itau-charge] erro no bridge:', result.error)
      return json({ error: result.error }, result.httpStatus)
    }
    payload = result.payload
  }

  /* ── 7. Atualizar charges ── */
  const { error: updateErr } = await admin
    .from('charges')
    .update({
      provider_charge_id: payload.providerChargeId,
      nosso_numero:       payload.nossoNumero,
      billing_type,
      pix_copy_paste:     payload.pixCopyPaste,
      pix_qr_code:        payload.pixQrCode,
      boleto_url:         payload.boletoUrl,
      payment_link:       null,
      due_date:           dueDate,
      payment_status:     'pending',
    })
    .eq('id', charge_id)

  if (updateErr) {
    console.error('[create-itau-charge] falha ao atualizar charges:', updateErr.message)
    // Cobrança já criada no Itaú — registrar mesmo assim, reconciliar via webhook
  }

  /* ── 8. Persistir raw_response em payment_transactions ── */
  const txRecordId = payload.txid ?? payload.nossoNumero ?? payload.providerChargeId
  await admin.from('payment_transactions').insert({
    charge_id:               charge.id,
    provider_transaction_id: txRecordId,
    status:                  'pending',
    amount:                  charge.gross_amount,
    raw_payload:             payload.rawPayload,
  })

  /* ── 9. Avançar appointment para awaiting_payment se ainda em draft ── */
  await admin
    .from('appointments')
    .update({ status: 'awaiting_payment', payment_status: 'pending' })
    .eq('id', charge.appointment_id)
    .eq('status', 'draft')

  logEvent(FN, 'charge_created', {
    charge_id:      charge.id,
    appointment_id: charge.appointment_id,
    billing_type,
    mock:           payload.isMock,
    provider_charge_id: payload.providerChargeId,
  })

  return json({
    success:            true,
    mock:               payload.isMock,
    provider:           'itau_bolecode',
    billing_type,
    provider_charge_id: payload.providerChargeId,
    nosso_numero:       payload.nossoNumero,
    txid:               payload.txid,
    pix_copy_paste:     payload.pixCopyPaste,
    pix_qr_code:        payload.pixQrCode,
    boleto_url:         payload.boletoUrl,
    payment_link:       null,
    due_date:           dueDate,
    amount:             charge.gross_amount,
  }, 201)
}

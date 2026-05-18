import 'dotenv/config'
import Fastify from 'fastify'
import https   from 'https'
import axios   from 'axios'
import { randomUUID } from 'crypto'

// ── Validação de envs na inicialização ────────────────────────────────────────
const REQUIRED = [
  'ITAU_CLIENT_ID',
  'ITAU_CLIENT_SECRET',
  'ITAU_CERT_PEM',
  'ITAU_KEY_PEM',
  'ITAU_API_KEY',
  'ITAU_BASE_URL',
  'BRIDGE_ACCESS_TOKEN',
]

const missing = REQUIRED.filter(k => !process.env[k])
if (missing.length > 0) {
  console.error(`[bridge] Envs ausentes: ${missing.join(', ')}`)
  process.exit(1)
}

// ── Helpers compartilhados ────────────────────────────────────────────────────

/**
 * Normaliza PEM: converte \n literal → quebra real, e envolve com cabeçalhos
 * se o conteúdo for apenas o corpo base64 sem -----BEGIN/END-----.
 */
function normalizePem(pem, type) {
  if (!pem) return pem
  let s = pem.replace(/\\n/g, '\n').trim()
  if (s.startsWith('-----BEGIN')) return s + '\n'
  return `-----BEGIN ${type}-----\n${s}\n-----END ${type}-----\n`
}

/** Cria https.Agent com mTLS — equivalente ao cert tuple do requests.post(..., cert=cert) */
function buildMtlsAgent() {
  return new https.Agent({
    cert: normalizePem(process.env.ITAU_CERT_PEM, 'CERTIFICATE'),
    key:  normalizePem(process.env.ITAU_KEY_PEM,  'PRIVATE KEY'),
  })
}

/**
 * Obtém access_token OAuth do Itaú.
 * Replica bolecode_service.py get_access_token() — apenas Content-Type, sem x-itau-apikey.
 * Lança Error com mensagem sanitizada em caso de falha.
 */
async function getOAuthToken(agent) {
  const tokenUrl = process.env.ITAU_TOKEN_URL ?? 'https://sts.itau.com.br/api/oauth/token'

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     process.env.ITAU_CLIENT_ID,
    client_secret: process.env.ITAU_CLIENT_SECRET,
  }).toString()

  let res
  try {
    res = await axios.post(tokenUrl, body, {
      headers:        { 'Content-Type': 'application/x-www-form-urlencoded' },
      httpsAgent:     agent,
      validateStatus: () => true,
      timeout:        30_000,
    })
  } catch (err) {
    const msg = err?.message ?? ''
    const isTls = /tls|certificate|handshake|ssl|x509|peer|verify/i.test(msg)
    throw new Error(isTls ? 'mTLS handshake falhou ao obter token OAuth.' : 'Rede inacessível ao obter token OAuth.')
  }

  if (res.status !== 200) {
    throw new Error(`Itaú retornou HTTP ${res.status} no OAuth — verifique client_id/secret.`)
  }

  const token = res.data?.access_token
  if (!token) throw new Error('Resposta OAuth sem access_token.')
  return token
}

// ── Formatação de valor (17 dígitos — centavos com zero-padding) ─────────────
// Equivalente a bolecode_service.py _format_value_17_digits
function formatValue17(amountReais) {
  const cents = Math.round(amountReais * 100)
  return String(cents).padStart(17, '0')
}

// ── Data atual no fuso BRT (UTC-3) ───────────────────────────────────────────
// Itaú valida data_emissao contra a data corrente no fuso do servidor deles (BRT).
// new Date().toISOString() retorna UTC — após 21h BRT o dia já virou em UTC.
function todayBRT() {
  const brt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  return brt.toISOString().split('T')[0]
}

// ── Data + N dias (YYYY-MM-DD) ────────────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split('T')[0]
}

// ── Sanitização de texto (proibidos do Itaú) ─────────────────────────────────
// Equivalente a bolecode_service.py _sanitize_text
function sanitizeText(text) {
  if (!text) return ''
  const forbidden = ['[', ']', ':', '<', '>', '&', ';', "'", '"', '`', '(', ')', '#', '*', '/', '|', 'ü']
  let s = text
  for (const c of forbidden) s = s.replaceAll(c, '')
  for (const word of ['http', 'javascript', 'alert']) {
    s = s.replace(new RegExp(word, 'gi'), '')
  }
  return s.trim()
}

// ── Fastify ───────────────────────────────────────────────────────────────────
const app = Fastify({ logger: { level: 'info' } })

app.addHook('preHandler', async (req, reply) => {
  if (req.url === '/healthz') return
  if (req.headers['x-bridge-token'] !== process.env.BRIDGE_ACCESS_TOKEN) {
    return reply.code(401).send({ error: 'Unauthorized.' })
  }
})

// ── GET /healthz ──────────────────────────────────────────────────────────────
app.get('/healthz', async () => ({ ok: true, service: 'veramo-itau-bridge' }))

// ── GET /v1/pem-check ─────────────────────────────────────────────────────────
app.get('/v1/pem-check', async () => {
  const analyzePem = (raw, label, type) => {
    if (!raw) return { label, present: false }
    const normalized = normalizePem(raw, type)
    return {
      label,
      present:            true,
      raw_length:         raw.length,
      normalized_length:  normalized.length,
      has_real_newlines:  raw.includes('\n'),
      has_literal_slash_n: raw.includes('\\n'),
      normalized_starts_with_begin: normalized.trimStart().startsWith('-----BEGIN'),
      first_30_normalized: normalized.slice(0, 30).replace(/\n/g, '<LF>'),
    }
  }
  return {
    cert: analyzePem(process.env.ITAU_CERT_PEM, 'ITAU_CERT_PEM', 'CERTIFICATE'),
    key:  analyzePem(process.env.ITAU_KEY_PEM,  'ITAU_KEY_PEM',  'PRIVATE KEY'),
  }
})

// ── POST /v1/oauth-test ───────────────────────────────────────────────────────
app.post('/v1/oauth-test', async (req, reply) => {
  const tokenUrl = process.env.ITAU_TOKEN_URL ?? 'https://sts.itau.com.br/api/oauth/token'
  const agent    = buildMtlsAgent()
  const start    = Date.now()

  let statusCode, sanitizedBody

  try {
    const res = await axios.post(tokenUrl, new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     process.env.ITAU_CLIENT_ID,
      client_secret: process.env.ITAU_CLIENT_SECRET,
    }).toString(), {
      headers:        { 'Content-Type': 'application/x-www-form-urlencoded' },
      httpsAgent:     agent,
      validateStatus: () => true,
      timeout:        30_000,
    })

    statusCode = res.status
    const data = res.data
    sanitizedBody = typeof data === 'object' && data !== null
      ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, k === 'access_token' ? '****' : v]))
      : { raw_text: String(data).slice(0, 400) }

  } catch (err) {
    const msg = err?.message ?? ''
    const isTls = /tls|certificate|handshake|ssl|x509|peer|verify/i.test(msg)
    return reply.code(502).send({
      success: false, status_code: null,
      error: isTls ? 'mTLS handshake falhou.' : `Rede inacessível: ${msg}`,
      latency_ms: Date.now() - start,
    })
  }

  return {
    success:         statusCode >= 200 && statusCode < 300,
    status_code:     statusCode,
    token_url:       tokenUrl,
    mtls_used:       true,
    headers_sent:    ['Content-Type'],
    body_keys_sent:  ['grant_type', 'client_id', 'client_secret'],
    response_body:   sanitizedBody,
    latency_ms:      Date.now() - start,
  }
})

// ── POST /v1/charges ──────────────────────────────────────────────────────────
//
// Replica bolecode_service.py _emitir_bolecode_empresa_pj linha a linha.
//
// Body esperado:
// {
//   amount:        number,           // valor em reais (ex: 150.00)
//   due_date:      string,           // YYYY-MM-DD
//   nosso_numero:  string,           // 8 dígitos
//   payer: {
//     nome:        string,
//     tipo_pessoa: "J" | "F",        // default "J"
//     cnpj:        string,           // 14 dígitos (sem máscara)
//     endereco: {
//       logradouro: string,
//       bairro:     string,
//       cidade:     string,
//       uf:         string,          // 2 letras
//       cep:        string,          // 8 dígitos
//     }
//   },
//   beneficiario_id: string,
//   pix_key:         string,
//   carteira_code:   string,         // default "109"
//   texto_ref:       string,         // até 6 chars (texto_seu_numero / texto_uso_beneficiario)
//   mensagem:        string,         // lista_mensagem_cobranca
//   correlation_id:  string,         // opcional — x-itau-correlationID
// }
//
app.post('/v1/charges', async (req, reply) => {
  const {
    amount, due_date, nosso_numero, correlation_id,
    payer, beneficiario_id, pix_key,
    carteira_code, texto_ref, mensagem,
  } = req.body ?? {}

  // ── Validação de input ──────────────────────────────────────────────────
  const errors = []
  if (!amount || amount <= 0)       errors.push('amount deve ser > 0')
  if (!due_date)                    errors.push('due_date é obrigatório (YYYY-MM-DD)')
  if (!nosso_numero)                errors.push('nosso_numero é obrigatório')
  if (!payer?.nome)                 errors.push('payer.nome é obrigatório')
  if (!payer?.cnpj)                 errors.push('payer.cnpj é obrigatório')
  if (!beneficiario_id)             errors.push('beneficiario_id é obrigatório')
  if (!pix_key)                     errors.push('pix_key é obrigatório')
  if (errors.length > 0) return reply.code(400).send({ error: errors.join('; ') })

  // ── Preparação — equivalente ao _emitir_bolecode_empresa_pj ────────────
  const textoRef6        = (texto_ref ? String(texto_ref).slice(0, 6) : '000000')
  const mensagemLimpa    = sanitizeText(mensagem || 'Cobranca')
  const valorFormatado   = formatValue17(amount)
  const dataEmissao      = todayBRT()
  const dataLimite       = addDays(due_date, 30)          // data_limite_pagamento = vencimento + 30d
  const cnpjDigits       = payer.cnpj.replace(/\D/g, '')
  const cep              = (payer.endereco?.cep ?? '01000000').replace(/\D/g, '').padEnd(8, '0').slice(0, 8)
  const correlationIdStr = correlation_id ?? randomUUID()
  const carteira         = carteira_code ?? '109'

  // ── Payload — replica exata do legado ──────────────────────────────────
  const payload = {
    etapa_processo_boleto: 'efetivacao',
    beneficiario: { id_beneficiario: beneficiario_id },
    dado_boleto: {
      tipo_boleto:                    'a vista',
      descricao_instrumento_cobranca: 'boleto_pix',
      texto_seu_numero:               textoRef6,
      codigo_carteira:                carteira,
      valor_total_titulo:             valorFormatado,
      codigo_especie:                 '01',
      data_emissao:                   dataEmissao,
      pagador: {
        pessoa: {
          nome_pessoa:  sanitizeText(payer.nome),
          tipo_pessoa: {
            codigo_tipo_pessoa: payer.tipo_pessoa ?? 'J',
            numero_cadastro_nacional_pessoa_juridica: cnpjDigits || '00000000000000',
          },
        },
        endereco: {
          nome_logradouro: sanitizeText(payer.endereco?.logradouro ?? 'Rua Principal 100'),
          nome_bairro:     sanitizeText(payer.endereco?.bairro     ?? 'Centro'),
          nome_cidade:     sanitizeText(payer.endereco?.cidade     ?? 'Sao Paulo'),
          sigla_UF:        payer.endereco?.uf  ?? 'SP',
          numero_CEP:      cep,
        },
      },
      dados_individuais_boleto: [{
        numero_nosso_numero:    String(nosso_numero),
        data_vencimento:        due_date,
        texto_uso_beneficiario: textoRef6,
        valor_titulo:           valorFormatado,
        data_limite_pagamento:  dataLimite,
      }],
      lista_mensagem_cobranca: [{ mensagem: mensagemLimpa }],
    },
    dados_qrcode: { chave: pix_key },
  }

  // ── OAuth + mTLS ────────────────────────────────────────────────────────
  const agent = buildMtlsAgent()
  let token
  try {
    token = await getOAuthToken(agent)
  } catch (err) {
    return reply.code(502).send({ error: err.message })
  }

  // ── POST ao Itaú Bolecode ───────────────────────────────────────────────
  // Headers: Bearer + x-itau-apikey + correlationID + Content-Type: application/json
  // (equivalente a _emitir_bolecode_empresa_pj linhas 311-316)
  const url   = `${process.env.ITAU_BASE_URL.replace(/\/$/, '')}/boletos_pix`
  const start = Date.now()

  app.log.info(`[charges] POST ${url} | correlationID: ${correlationIdStr} | amount: ${amount} | nosso_numero: ${nosso_numero} | carteira: ${carteira}`)

  let res
  try {
    res = await axios.post(url, payload, {
      headers: {
        'Authorization':       `Bearer ${token}`,
        'x-itau-apikey':       process.env.ITAU_API_KEY,
        'x-itau-correlationID': correlationIdStr,
        'Content-Type':        'application/json',
      },
      httpsAgent:     agent,
      validateStatus: () => true,
      timeout:        60_000,
    })
  } catch (err) {
    app.log.error(`[charges] timeout/erro na chamada boletos_pix após ${Date.now() - start}ms: ${err.message}`)
    return reply.code(502).send({ error: `Rede inacessível ao criar Bolecode: ${err.message}` })
  }

  const latencyMs    = Date.now() - start
  const statusCode   = res.status
  const responseData = res.data

  app.log.info(`[charges] Itaú respondeu HTTP ${statusCode} em ${latencyMs}ms`)

  // ── HTTP 202 — processamento assíncrono (mesmo que legado) ──────────────
  if (statusCode === 202) {
    return {
      success:      true,
      status:       'processing',
      message:      'Bolecode em processamento assíncrono. Consulte em instantes.',
      nosso_numero: String(nosso_numero),
      due_date,
      amount,
      latency_ms:   latencyMs,
    }
  }

  // ── Erro do Itaú — extrair mensagem (mesmo que legado) ─────────────────
  if (statusCode >= 400) {
    const detail = responseData?.detalhe_excecao?.[0]?.mensagem
                ?? responseData?.mensagem
                ?? responseData?.erros?.[0]?.mensagem
                ?? ''
    const errorMsg = detail ? `HTTP ${statusCode} — ${detail}` : `HTTP ${statusCode}`
    app.log.error(`[charges] erro Itaú: ${errorMsg}`)
    app.log.error(`[charges] raw_response Itaú: ${JSON.stringify(responseData)}`)
    return reply.code(statusCode >= 500 ? 502 : 422).send({
      success:      false,
      status_code:  statusCode,
      error:        errorMsg,
      raw_response: responseData,
      latency_ms:   latencyMs,
    })
  }

  // ── Parsing de resposta — replica exata do legado ──────────────────────
  // data = response_data.get('data', response_data)
  // dados_individuais = dado_boleto.get('dados_individuais_boleto', [{}])[0]
  // dados_qrcode = data.get('dados_qrcode', {})
  const data            = responseData?.data ?? responseData
  const dadoBoleto      = data?.dado_boleto  ?? {}
  const dadosIndividuais = dadoBoleto?.dados_individuais_boleto?.[0] ?? {}
  const dadosQrcode     = data?.dados_qrcode ?? {}

  if (!dadosQrcode.txid) {
    app.log.warn('[charges] pix_txid vazio no retorno Itaú.')
  }

  return {
    success:           true,
    status_code:       statusCode,
    provider_charge_id: dadosIndividuais.id_boleto_individual ?? null,
    nosso_numero:      dadosIndividuais.numero_nosso_numero    ?? String(nosso_numero),
    txid:              dadosQrcode.txid    ?? null,
    pix_copy_paste:    dadosQrcode.emv     ?? null,
    pix_qr_code:       dadosQrcode.base64  ?? null,
    boleto_url:        dadosIndividuais.numero_linha_digitavel ?? null,
    due_date:          dadosIndividuais.data_vencimento        ?? due_date,
    amount,
    latency_ms:        latencyMs,
    raw_response:      responseData,
  }
})

// ── GET /v1/api-ping ──────────────────────────────────────────────────────────
//
// Diagnóstico rápido: testa conectividade mTLS com o endpoint boletos_pix do Itaú.
// Faz OAuth + GET no URL base (sem body) para ver se o servidor responde.
//
app.get('/v1/api-ping', async (req, reply) => {
  const agent = buildMtlsAgent()
  const results = {}

  // 1. OAuth
  const t0 = Date.now()
  let token
  try {
    token = await getOAuthToken(agent)
    results.oauth = { ok: true, latency_ms: Date.now() - t0 }
  } catch (err) {
    results.oauth = { ok: false, error: err.message, latency_ms: Date.now() - t0 }
    return { results }
  }

  // 2. GET no base URL (sem body — 405 ou similar é aceitável, o que importa é o servidor responder)
  const base = process.env.ITAU_BASE_URL.replace(/\/$/, '')
  const pingUrl = `${base}/boletos_pix`
  const t1 = Date.now()
  try {
    const r = await axios.get(pingUrl, {
      headers: {
        'Authorization':        `Bearer ${token}`,
        'x-itau-apikey':        process.env.ITAU_API_KEY,
        'x-itau-correlationID': randomUUID(),
      },
      httpsAgent:     agent,
      validateStatus: () => true,
      timeout:        15_000,
    })
    results.boletos_pix_get = {
      ok: true,
      status: r.status,
      latency_ms: Date.now() - t1,
      url: pingUrl,
    }
  } catch (err) {
    results.boletos_pix_get = {
      ok: false,
      error: err.message,
      latency_ms: Date.now() - t1,
      url: pingUrl,
    }
  }

  // 3. Também testa o host com uma conexão TCP simples (sem mTLS) apenas para diferenciar
  //    problemas de rede de problemas de certificado
  const t2 = Date.now()
  try {
    const r2 = await axios.get('https://sts.itau.com.br', {
      validateStatus: () => true,
      timeout: 5_000,
    })
    results.sts_host = { ok: true, status: r2.status, latency_ms: Date.now() - t2 }
  } catch (err) {
    results.sts_host = { ok: false, error: err.message.slice(0, 120), latency_ms: Date.now() - t2 }
  }

  return {
    itau_base_url: base,
    results,
  }
})

// ── GET /v1/webhook-check ─────────────────────────────────────────────────────
//
// Consulta o webhook PIX registrado no Itaú para uma chave.
// Query: ?pix_key=pix@secabc.org.br  (opcional: &api_base_url=...)
//
app.get('/v1/webhook-check', async (req, reply) => {
  const { pix_key, api_base_url } = req.query ?? {}
  if (!pix_key) return reply.code(400).send({ error: 'pix_key query param é obrigatório' })

  const agent = buildMtlsAgent()
  let token
  try { token = await getOAuthToken(agent) } catch (err) {
    return reply.code(502).send({ error: err.message })
  }

  const apiRoot = process.env.ITAU_BASE_URL.replace(/\/pix_recebimentos_conciliacoes.*$/, '')

  // Candidatos em ordem de probabilidade
  const candidates = api_base_url
    ? [{ base: api_base_url.replace(/\/$/, ''), encode: true }]
    : [
        { base: `${apiRoot}/pix_recebimentos_conciliacoes/v2`, encode: true  },
        { base: `${apiRoot}/pix_recebimentos_conciliacoes/v2`, encode: false },
        { base: `${apiRoot}/boletoscash/v2`,                   encode: true  },
        { base: `${apiRoot}/boletoscash/v2`,                   encode: false },
        { base: `${apiRoot}/pix/v2`,                           encode: true  },
      ]

  const results = []
  for (const { base, encode } of candidates) {
    const key = encode ? encodeURIComponent(pix_key) : pix_key
    const url = `${base}/webhook/${key}`
    let res
    try {
      res = await axios.get(url, {
        headers: {
          'Authorization':        `Bearer ${token}`,
          'x-itau-apikey':        process.env.ITAU_API_KEY,
          'x-itau-correlationID': randomUUID(),
        },
        httpsAgent:     agent,
        validateStatus: () => true,
        timeout:        15_000,
      })
    } catch (err) {
      results.push({ base, url, error: err.message })
      continue
    }
    results.push({ base, url, status: res.status, body: res.data })
  }

  return { results }
})

// ── GET /v1/charge-status ─────────────────────────────────────────────────────
//
// Consulta o status de um boleto. Tenta múltiplos paths em sequência:
//   1. GET /boletos_pix/{id_boleto_individual}   (provider_charge_id)
//   2. GET /boletos_pix/{nosso_numero}            (nosso_numero no path)
//   3. GET /boletos_pix?id_beneficiario=X&codigo_nosso_numero=Y
// Query: ?nosso_numero=&beneficiario_id=  (+ opcional: &id_boleto=)
//
app.get('/v1/charge-status', async (req, reply) => {
  const { nosso_numero, beneficiario_id, id_boleto } = req.query ?? {}
  if (!nosso_numero && !id_boleto) return reply.code(400).send({ error: 'nosso_numero ou id_boleto é obrigatório' })

  const agent = buildMtlsAgent()
  let token
  try { token = await getOAuthToken(agent) } catch (err) {
    return reply.code(502).send({ error: err.message })
  }

  const base    = process.env.ITAU_BASE_URL.replace(/\/$/, '')
  const headers = {
    'Authorization':        `Bearer ${token}`,
    'x-itau-apikey':        process.env.ITAU_API_KEY,
    'x-itau-correlationID': randomUUID(),
  }

  // Candidatos de URL a tentar em ordem
  const candidates = []
  if (id_boleto)    candidates.push(`${base}/boletos_pix/${encodeURIComponent(id_boleto)}`)
  if (nosso_numero) candidates.push(`${base}/boletos_pix/${encodeURIComponent(nosso_numero)}`)
  if (nosso_numero && beneficiario_id) {
    candidates.push(`${base}/boletos_pix?id_beneficiario=${encodeURIComponent(beneficiario_id)}&codigo_nosso_numero=${encodeURIComponent(nosso_numero)}`)
    candidates.push(`${base}/boletos_pix?id_beneficiario=${encodeURIComponent(beneficiario_id)}&nosso_numero=${encodeURIComponent(nosso_numero)}`)
  }

  const attempts = []
  for (const url of candidates) {
    const start = Date.now()
    let res
    try {
      res = await axios.get(url, { headers, httpsAgent: agent, validateStatus: () => true, timeout: 15_000 })
    } catch (err) {
      attempts.push({ url, error: err.message })
      continue
    }
    const latencyMs = Date.now() - start
    attempts.push({ url, status: res.status })
    app.log.info(`[charge-status] ${url} → HTTP ${res.status} em ${latencyMs}ms`)
    if (res.status !== 404 && res.status !== 405) {
      return { status_code: res.status, nosso_numero, raw_response: res.data, latency_ms: latencyMs }
    }
  }

  return { status_code: null, nosso_numero, attempts, message: 'Nenhum path retornou dados.' }
})

// ── POST /v1/webhook-register ─────────────────────────────────────────────────
//
// Registra o webhook PIX no Itaú (PUT /v2/webhook/{chave}).
// Body esperado: { pix_key: string, webhook_url: string }
//
app.post('/v1/webhook-register', async (req, reply) => {
  const { pix_key, webhook_url, api_base_url } = req.body ?? {}
  if (!pix_key)     return reply.code(400).send({ error: 'pix_key é obrigatório' })
  if (!webhook_url) return reply.code(400).send({ error: 'webhook_url é obrigatório' })

  const agent = buildMtlsAgent()
  let token
  try { token = await getOAuthToken(agent) } catch (err) {
    return reply.code(502).send({ error: err.message })
  }

  // api_base_url no body sobrescreve o default (útil para testar paths alternativos)
  // Default: ITAU_WEBHOOK_BASE_URL ?? derivado do ITAU_BASE_URL trocando o produto por /pix/v2
  const defaultWebhookBase = process.env.ITAU_WEBHOOK_BASE_URL
    ?? process.env.ITAU_BASE_URL.replace(/pix_recebimentos_conciliacoes\/v2.*$/, 'pix/v2')
  const base = (api_base_url ?? defaultWebhookBase).replace(/\/$/, '')
  const url  = `${base}/webhook/${encodeURIComponent(pix_key)}`
  app.log.info(`[webhook-register] PUT ${url}`)
  const start = Date.now()

  let res
  try {
    res = await axios.put(url, { webhookUrl: webhook_url }, {
      headers: {
        'Authorization':        `Bearer ${token}`,
        'x-itau-apikey':        process.env.ITAU_API_KEY,
        'x-itau-correlationID': randomUUID(),
        'Content-Type':         'application/json',
      },
      httpsAgent:     agent,
      validateStatus: () => true,
      timeout:        30_000,
    })
  } catch (err) {
    return reply.code(502).send({ error: `Rede inacessível: ${err.message}` })
  }

  app.log.info(`[webhook-register] Itaú respondeu HTTP ${res.status} em ${Date.now() - start}ms`)

  return {
    success:     res.status >= 200 && res.status < 300,
    status_code: res.status,
    pix_key,
    webhook_url,
    raw_response: res.data,
    latency_ms:  Date.now() - start,
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '0.0.0.0'

try {
  await app.listen({ port, host })
  app.log.info(`veramo-itau-bridge pronto em http://${host}:${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

/**
 * itau-provider — módulo interno reutilizável para integração Itaú/Bolecode
 *
 * Responsabilidades:
 *   - Carregar e validar secrets do ambiente
 *   - Criar cliente HTTP mTLS (Deno.createHttpClient)
 *   - Obter token OAuth (client_credentials) via mTLS
 *   - Montar headers padrão para chamadas à API Itaú
 *   - Sanitizar logs para nunca expor credenciais
 *
 * O que este módulo NÃO faz:
 *   - Não cria cobranças (responsabilidade do caller)
 *   - Não lê nem escreve no banco (responsabilidade do caller)
 *   - Não loga token, certificados, client_secret ou api_key
 *   - Não retorna o access_token em respostas HTTP (só internamente)
 *
 * Endpoints documentados (configurar via secrets):
 *   Token OAuth  → ITAU_TOKEN_URL  (default: https://sts.itau.com.br/api/oauth/token)
 *   Bolecode     → ITAU_BASE_URL/boletos_pix
 *   PIX status   → ITAU_PIX_STATUS_URL/cob/{txid}
 */

// ── Tipos públicos ─────────────────────────────────────────────────────────────

export type ItauErrorType =
  | 'missing_secrets'
  | 'mtls_api_unavailable'
  | 'cert_parse_failed'
  | 'tls_handshake_failed'
  | 'network_unreachable'
  | 'oauth_error'
  | 'api_error'
  | 'unknown'

export type Ok<T>  = { ok: true;  value: T }
export type Err    = { ok: false; error: string; type: ItauErrorType }
export type Result<T> = Ok<T> | Err

/** Secrets obrigatórios para obter token OAuth. */
export type ItauCoreSecrets = {
  certPem:      string
  keyPem:       string
  clientId:     string
  clientSecret: string
  apiKey:       string
  tokenUrl:     string
}

/** Secrets adicionais para criar/consultar Bolecode (Fase 4). */
export type ItauBolecodeSecrets = ItauCoreSecrets & {
  baseUrl: string
}

/** Handle para o cliente HTTP mTLS — deve ser fechado após uso. */
export type ItauMtlsClient = {
  // deno-lint-ignore no-explicit-any
  handle: any
  close(): void
}

// ── Carregamento de secrets ────────────────────────────────────────────────────

/**
 * Carrega os secrets necessários para OAuth/mTLS.
 * ITAU_TOKEN_URL é opcional — usa o default de produção se ausente.
 * Retorna Err se qualquer secret obrigatório estiver ausente.
 */
export function loadCoreSecrets(): Result<ItauCoreSecrets> {
  const certPem      = Deno.env.get('ITAU_CERT_PEM')
  const keyPem       = Deno.env.get('ITAU_KEY_PEM')
  const clientId     = Deno.env.get('ITAU_CLIENT_ID')
  const clientSecret = Deno.env.get('ITAU_CLIENT_SECRET')
  const apiKey       = Deno.env.get('ITAU_API_KEY')
  // Default documentado no legado — sobrescrever com secret para sandbox
  const tokenUrl     = Deno.env.get('ITAU_TOKEN_URL') ?? 'https://sts.itau.com.br/api/oauth/token'

  const missing: string[] = []
  if (!certPem)      missing.push('ITAU_CERT_PEM')
  if (!keyPem)       missing.push('ITAU_KEY_PEM')
  if (!clientId)     missing.push('ITAU_CLIENT_ID')
  if (!clientSecret) missing.push('ITAU_CLIENT_SECRET')
  if (!apiKey)       missing.push('ITAU_API_KEY')

  if (missing.length > 0) {
    return {
      ok:    false,
      error: `Secrets Itaú ausentes: ${missing.join(', ')}. Configure via 'supabase secrets set'.`,
      type:  'missing_secrets',
    }
  }

  return {
    ok:    true,
    value: { certPem: certPem!, keyPem: keyPem!, clientId: clientId!, clientSecret: clientSecret!, apiKey: apiKey!, tokenUrl },
  }
}

/**
 * Carrega secrets de core + ITAU_BASE_URL (necessário para Bolecode).
 * Usar apenas quando a função for criar ou consultar Bolecodes.
 */
export function loadBolecodeSecrets(): Result<ItauBolecodeSecrets> {
  const core = loadCoreSecrets()
  if (!core.ok) return core

  const baseUrl = Deno.env.get('ITAU_BASE_URL')
  if (!baseUrl) {
    return {
      ok:    false,
      error: 'Secret ITAU_BASE_URL ausente — necessário para criar/consultar Bolecodes.',
      type:  'missing_secrets',
    }
  }

  return { ok: true, value: { ...core.value, baseUrl: baseUrl.replace(/\/$/, '') } }
}

// ── Cliente mTLS ───────────────────────────────────────────────────────────────

/**
 * Cria um cliente HTTP Deno com certificado de cliente (mTLS).
 * Requer que Deno.createHttpClient esteja disponível no runtime.
 *
 * O caller é responsável por chamar client.close() após uso
 * para liberar recursos de rede.
 */
export function createMtlsClient(secrets: ItauCoreSecrets): Result<ItauMtlsClient> {
  // deno-lint-ignore no-explicit-any
  const denoAny = Deno as any

  if (typeof denoAny.createHttpClient !== 'function') {
    return {
      ok:    false,
      error: 'Deno.createHttpClient não disponível neste runtime.',
      type:  'mtls_api_unavailable',
    }
  }

  try {
    const handle = denoAny.createHttpClient({
      certChain:  secrets.certPem,
      privateKey: secrets.keyPem,
    })
    return { ok: true, value: { handle, close: () => handle.close() } }
  } catch {
    // Não repassar erro bruto — pode conter fragmentos do PEM
    return {
      ok:    false,
      error: 'Falha ao criar cliente mTLS — PEM malformado ou incompatível.',
      type:  'cert_parse_failed',
    }
  }
}

// ── OAuth token ────────────────────────────────────────────────────────────────

/**
 * Obtém um access_token OAuth do Itaú via mTLS.
 *
 * O token retornado é SOMENTE para uso interno em chamadas à API Itaú.
 * Nunca deve aparecer em logs, respostas HTTP ou banco de dados.
 *
 * Tokens Itaú têm validade de ~1h. Como Edge Functions são stateless,
 * não há cache entre invocações — um token novo é obtido por request.
 * Isso é aceitável: a chamada de token leva ~100-200ms.
 */
export async function fetchOAuthToken(
  secrets: ItauCoreSecrets,
  client:  ItauMtlsClient,
): Promise<Result<string>> {
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     secrets.clientId,
    client_secret: secrets.clientSecret,
  })

  let res: Response
  try {
    res = await fetch(secrets.tokenUrl, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent':   'veramo/4.0 (itau-provider)',
      },
      body,
      // @ts-ignore — opção Deno-specific para mTLS client
      client: client.handle,
    })
  } catch (err) {
    return {
      ok:    false,
      error: classifyNetworkError(err) === 'tls_handshake_failed'
        ? 'Handshake mTLS falhou ao obter token OAuth.'
        : 'Rede inacessível ao tentar obter token OAuth.',
      type: classifyNetworkError(err),
    }
  }

  if (!res.ok) {
    // Descartar body sem leitura — pode conter detalhes de credenciais
    await res.body?.cancel()
    return {
      ok:    false,
      error: `Itaú retornou HTTP ${res.status} ao autenticar — verifique client_id/secret/api_key.`,
      type:  'oauth_error',
    }
  }

  let tokenData: { access_token?: string }
  try {
    tokenData = await res.json()
  } catch {
    return { ok: false, error: 'Resposta de token OAuth não é JSON válido.', type: 'unknown' }
  }

  if (!tokenData.access_token) {
    return { ok: false, error: 'Resposta OAuth sem access_token.', type: 'oauth_error' }
  }

  return { ok: true, value: tokenData.access_token }
}

// ── Headers padrão ─────────────────────────────────────────────────────────────

/**
 * Monta os headers obrigatórios para chamadas autenticadas à API Itaú.
 * Inclui Authorization Bearer + x-itau-apikey + Content-Type.
 */
export function buildItauHeaders(secrets: ItauCoreSecrets, token: string): Record<string, string> {
  return {
    'Authorization':  `Bearer ${token}`,
    'x-itau-apikey':  secrets.apiKey,
    'Content-Type':   'application/json',
    'Accept':         'application/json',
    'User-Agent':     'veramo/4.0 (itau-provider)',
  }
}

// ── Log seguro ─────────────────────────────────────────────────────────────────

/**
 * Retorna uma representação segura de um valor sensível para logs.
 * Mostra apenas os primeiros 6 caracteres + '****'.
 * Nunca usar para logar certPem, keyPem, clientSecret ou access_token.
 */
export function sanitizeLog(value: string): string {
  if (!value || value.length <= 6) return '****'
  return `${value.slice(0, 6)}****`
}

// ── Classificação de erros de rede ─────────────────────────────────────────────

/** Classifica um erro de fetch em ItauErrorType sem expor a mensagem original. */
export function classifyNetworkError(err: unknown): ItauErrorType {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  if (
    msg.includes('tls') || msg.includes('certificate') || msg.includes('handshake') ||
    msg.includes('ssl') || msg.includes('peer') || msg.includes('x509') || msg.includes('verify')
  ) return 'tls_handshake_failed'

  if (
    msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnrefused') ||
    msg.includes('enotfound') || msg.includes('network') || msg.includes('dns') ||
    msg.includes('unreachable')
  ) return 'network_unreachable'

  return 'unknown'
}

// ── Utilitário de data de vencimento ──────────────────────────────────────────

/**
 * Retorna data de vencimento em YYYY-MM-DD:
 *   PIX    → D+1
 *   BOLETO → D+5
 */
export function bolecodeDueDate(billingType: 'PIX' | 'BOLETO'): string {
  const d = new Date()
  d.setDate(d.getDate() + (billingType === 'BOLETO' ? 5 : 1))
  return d.toISOString().split('T')[0]
}

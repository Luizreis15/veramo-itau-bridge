/**
 * CORS — Etapa 5
 * - corsHeaders(req): rotas chamadas pelo browser (origem refletida se permitida)
 * - WEBHOOK_CORS_HEADERS: webhooks e chamadas server-to-server (sem Origin)
 */

const DEFAULT_ORIGINS = [
  'https://www.veramo.com.br',
  'https://veramo.com.br',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
]

export const WEBHOOK_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret, asaas-access-token, x-itau-webhook-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function extraOrigins(): string[] {
  const raw = Deno.env.get('ALLOWED_ORIGINS') ?? ''
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

export function isAllowedOrigin(origin: string): boolean {
  if (!origin) return false
  const allowed = [...DEFAULT_ORIGINS, ...extraOrigins()]
  if (allowed.includes(origin)) return true
  if (/^https:\/\/localhost(:\d+)?$/.test(origin)) return true
  if (/^https:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true
  // Vercel production + previews
  if (/^https:\/\/[\w-]+\.vercel\.app$/.test(origin)) return true
  return false
}

/** Headers CORS para requisições do frontend (SPA). */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': WEBHOOK_CORS_HEADERS['Access-Control-Allow-Headers'],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
  if (origin && isAllowedOrigin(origin)) {
    base['Access-Control-Allow-Origin'] = origin
  }
  return base
}

/** Factory de resposta JSON com CORS da requisição (use dentro de Deno.serve). */
export function makeJson(cors: Record<string, string>) {
  return function json(body: unknown, status = 200): Response {
    const b = body as Record<string, unknown>
    if (b['error'] && !b['message']) b['message'] = b['error']
    return new Response(JSON.stringify(b), {
      status,
      headers: { 'Content-Type': 'application/json', ...cors },
    })
  }
}

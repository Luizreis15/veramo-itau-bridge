/**
 * Autenticação compartilhada para Edge Functions (Etapa 1).
 * - requireUser: JWT validado via Supabase Auth (assinatura verificada)
 * - requireInternalCall: apenas service role ou x-internal-secret
 * - requireUserOrInternal: rotas híbridas (Meet, lembretes, etc.)
 */

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { corsHeaders, WEBHOOK_CORS_HEADERS } from './cors.ts'

export { corsHeaders, WEBHOOK_CORS_HEADERS }

/** Webhooks / cron / internal — mantém wildcard. Browser: use corsHeaders(req). */
export const CORS_HEADERS = WEBHOOK_CORS_HEADERS

export type AuthUser = { id: string; email?: string }

export type CallerProfile = {
  id:         string
  role:       string
  union_id:   string | null
  office_id:  string | null
  company_id: string | null
}

export function jsonAuthError(
  message: string,
  status: number,
  cors: Record<string, string> = CORS_HEADERS,
): Response {
  return new Response(JSON.stringify({ error: message, message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  })
}

export function getBearerToken(req: Request): string | null {
  const h = (req.headers.get('Authorization') ?? '').replace(/\s+/g, ' ').trim()
  const m = h.match(/^Bearer\s+(.+)$/i)
  return m?.[1]?.replace(/\s/g, '').trim() || null
}

function isAnonKey(token: string): boolean {
  const anon = Deno.env.get('SUPABASE_ANON_KEY')
  return !!anon && token === anon
}

function parseJwtPayload(token: string): { ref?: string; role?: string } | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const pad = '='.repeat((4 - (parts[1].length % 4)) % 4)
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/') + pad
    return JSON.parse(atob(b64))
  } catch {
    return null
  }
}

function projectRefFromUrl(): string | null {
  const m = (Deno.env.get('SUPABASE_URL') ?? '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)
  return m?.[1] ?? null
}

/** Aceita service role por igualdade com env OU JWT com role=service_role do mesmo projeto. */
export function isServiceRoleToken(token: string): boolean {
  const clean = token.replace(/\s/g, '')
  const sk    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')?.replace(/\s/g, '')
  if (sk && clean === sk) return true

  const payload = parseJwtPayload(clean)
  if (!payload || payload.role !== 'service_role') return false

  const ref = projectRefFromUrl()
  return !ref || payload.ref === ref
}

export function isInternalSecret(req: Request): boolean {
  const secret = Deno.env.get('INTERNAL_FUNCTION_SECRET')
  if (!secret) return false
  return req.headers.get('x-internal-secret') === secret
}

/** Bloqueia chamadas com anon key ou JWT de usuário em funções internas. */
export function requireInternalCall(
  req: Request,
  cors: Record<string, string> = CORS_HEADERS,
): Response | null {
  const token = getBearerToken(req)
  if (!token) return jsonAuthError('Não autorizado.', 401, cors)
  if (isServiceRoleToken(token) || isInternalSecret(req)) return null
  return jsonAuthError('Acesso interno negado.', 403, cors)
}

/** Valida JWT de usuário autenticado (não aceita anon key). */
export async function requireUser(
  req: Request,
  cors: Record<string, string> = CORS_HEADERS,
): Promise<{ user: AuthUser; token: string } | Response> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !anonKey) {
    return jsonAuthError('Configuração ausente.', 500, cors)
  }

  const token = getBearerToken(req)
  if (!token) return jsonAuthError('Não autorizado.', 401, cors)
  if (isAnonKey(token)) return jsonAuthError('Não autorizado.', 401, cors)
  if (isServiceRoleToken(token)) {
    return jsonAuthError('Use credencial de usuário, não service role.', 403, cors)
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data: { user }, error } = await authClient.auth.getUser(token)
  if (error || !user) return jsonAuthError('Não autorizado.', 401, cors)

  return { user: { id: user.id, email: user.email }, token }
}

export async function requireUserOrInternal(
  req: Request,
  cors: Record<string, string> = CORS_HEADERS,
): Promise<{ user: AuthUser; token: string } | { internal: true } | Response> {
  const token = getBearerToken(req)
  if (!token) return jsonAuthError('Não autorizado.', 401, cors)
  if (isServiceRoleToken(token) || isInternalSecret(req)) {
    return { internal: true }
  }
  if (isAnonKey(token)) return jsonAuthError('Não autorizado.', 401, cors)
  return requireUser(req, cors)
}

export async function getCallerProfile(
  admin: SupabaseClient,
  userId: string,
): Promise<CallerProfile | null> {
  const { data, error } = await admin
    .from('profiles')
    .select('id, role, union_id, office_id, company_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  return data as CallerProfile
}

/** Verifica acesso ao agendamento (espelha regras RLS principais). */
export async function userCanAccessAppointment(
  admin: SupabaseClient,
  userId: string,
  appointmentId: string,
): Promise<boolean> {
  const profile = await getCallerProfile(admin, userId)
  if (!profile) return false

  const { data: appt } = await admin
    .from('appointments')
    .select('id, union_id, company_id, office_id, homologator_id')
    .eq('id', appointmentId)
    .maybeSingle()
  if (!appt) return false

  if (profile.role === 'super_admin') return true

  if (['union_master', 'union_operator'].includes(profile.role)) {
    return profile.union_id === appt.union_id
  }

  if (profile.role === 'union_homologator') {
    const { data: h } = await admin
      .from('homologators')
      .select('id')
      .eq('profile_id', profile.id)
      .maybeSingle()
    return h?.id === appt.homologator_id
  }

  if (['company_master', 'company_user'].includes(profile.role)) {
    return profile.company_id === appt.company_id
  }

  if (['office_master', 'office_user'].includes(profile.role)) {
    if (appt.office_id && appt.office_id === profile.office_id) return true
    if (!profile.office_id) return false
    const { data: link } = await admin
      .from('company_office_links')
      .select('id')
      .eq('company_id', appt.company_id)
      .eq('office_id', profile.office_id)
      .eq('active', true)
      .maybeSingle()
    return !!link
  }

  return false
}

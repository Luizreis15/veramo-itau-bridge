/**
 * Dispara create-meet-event quando pagamento confirmado E horário definido.
 * Idempotente — ignora se já existe meet_link ou faltam pré-requisitos.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const PAID_STATUSES = new Set([
  'payment_confirmed',
  'awaiting_documents',
  'documents_submitted',
  'returned_for_correction',
  'scheduled',
  'in_progress',
  'awaiting_signatures',
  'fully_signed',
  'completed',
])

export async function triggerMeetIfReady(
  supabaseUrl: string,
  serviceKey: string,
  appointmentId: string,
): Promise<void> {
  if (!appointmentId) return

  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } })

  const { data: appt, error } = await admin
    .from('appointments')
    .select('id, meet_link, scheduled_start_at, payment_status, status')
    .eq('id', appointmentId)
    .maybeSingle()

  if (error || !appt) {
    console.warn('[trigger-meet-if-ready] appt não encontrado:', appointmentId, error?.message)
    return
  }

  if (appt.meet_link) return
  if (!appt.scheduled_start_at) {
    console.log('[trigger-meet-if-ready] aguardando horário:', appointmentId)
    return
  }

  const isPaid =
    appt.payment_status === 'paid' ||
    PAID_STATUSES.has(appt.status)

  if (!isPaid) {
    console.log('[trigger-meet-if-ready] aguardando pagamento:', appointmentId)
    return
  }

  const res = await fetch(`${supabaseUrl}/functions/v1/create-meet-event`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ appointment_id: appointmentId }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    console.warn('[trigger-meet-if-ready] create-meet falhou:', appointmentId, res.status, body.slice(0, 200))
    return
  }

  console.log('[trigger-meet-if-ready] meet disparado:', appointmentId)
}

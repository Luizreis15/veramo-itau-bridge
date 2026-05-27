/**
 * Log estruturado (uma linha JSON) para Edge Functions — Etapa 4.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export type LogFields = Record<string, string | number | boolean | null | undefined>

export function logEvent(
  functionName: string,
  event: string,
  fields: LogFields = {},
  level: LogLevel = 'info',
): void {
  const line = JSON.stringify({
    ts:       new Date().toISOString(),
    level,
    function: functionName,
    event,
    ...fields,
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

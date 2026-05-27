/**
 * itau-bolecode-mapper — traduz dados Veramo 2.0 → payload Itaú Bolecode
 *
 * Não faz chamadas de rede. Não lê secrets. Puro dado → dado.
 * Testável com mocks sem infraestrutura.
 */

import type {
  ItauBolecodeRequest,
  ItauDadosIndividuais,
  ItauPessoa,
  ItauEndereco,
  BolecodeCreateResult,
  ItauBolecodeResponse,
} from './itau-bolecode-types.ts'

// ── Tipos de entrada ──────────────────────────────────────────────────────────

/** Campos da tabela charges usados pelo mapper */
export type ChargeContext = {
  id:           string    // UUID
  gross_amount: number
}

/** Campos da tabela appointments usados pelo mapper */
export type AppointmentContext = {
  id:        string
  protocol:  string
  employee_name: string
}

/** Campos da tabela companies usados pelo mapper */
export type CompanyContext = {
  legal_name:         string
  cnpj:               string
  address_line:       string | null
  address_number:     string | null
  address_complement: string | null
  neighborhood:       string | null
  city:               string | null
  state:              string | null
  zip_code:           string | null
}

/**
 * Campos Itaú da tabela unions — adicionados pela migration 20260516200000.
 * Todos obrigatórios para emissão real (validar antes de chamar o mapper).
 */
export type UnionItauContext = {
  itau_beneficiario_id: string    // ID do beneficiário cadastrado no Itaú
  itau_pix_key:         string    // chave PIX para geração do QR Code Bolecode
  itau_carteira_code:   string    // código de carteira, ex: "109"
}

export type BolecodeMapperInput = {
  charge:      ChargeContext
  appointment: AppointmentContext
  company:     CompanyContext
  union:       UnionItauContext
  billingType: 'PIX' | 'BOLETO'
  dueDate:     string              // YYYY-MM-DD
}

// ── nosso_numero ──────────────────────────────────────────────────────────────

/**
 * Gera um nosso_numero de 8 dígitos a partir do UUID da cobrança.
 *
 * Estratégia: XOR dos 4 grupos numéricos do UUID, módulo 10^8.
 * Determinístico: o mesmo charge.id sempre gera o mesmo nosso_numero.
 * Unicidade: colisão probabilisticamente desprezível para < 10k cobranças/beneficiário.
 *
 * ATENÇÃO: para produção de alto volume substituir por sequence do Postgres
 * (tabela itau_nosso_numero_seq com GENERATED ALWAYS AS IDENTITY).
 */
/** Extrai txid PIX do EMV Bolecode: ...api.itau/pix/qr/v2/{uuid}... */
export function extractPixTxidFromEMV(pixCopyPaste: string | null): string | null {
  if (!pixCopyPaste) return null
  const match = pixCopyPaste.match(/api\.itau\/pix\/qr\/v\d+\/([0-9a-f-]{36})/i)
  return match?.[1] ?? null
}

/**
 * ID para consulta PIX / payment_transactions.
 * Prioriza UUID do EMV; ignora txid BL... (id de boleto) retornado pelo bridge.
 */
export function resolvePixTransactionId(
  pixCopyPaste: string | null,
  bridgeTxid: string | null,
): string | null {
  const emvTxid = extractPixTxidFromEMV(pixCopyPaste)
  if (emvTxid) return emvTxid
  if (bridgeTxid && !bridgeTxid.startsWith('BL')) return bridgeTxid
  return null
}

export function generateNossoNumero(chargeId: string): string {
  // Remove hífens e trabalha com os 32 hex chars
  const hex   = chargeId.replace(/-/g, '')
  // Particiona em 4 chunks de 8 chars, converte para int, XOR entre si
  const parts = [
    parseInt(hex.slice(0,  8), 16),
    parseInt(hex.slice(8,  16), 16),
    parseInt(hex.slice(16, 24), 16),
    parseInt(hex.slice(24, 32), 16),
  ]
  const combined = parts.reduce((acc, v) => acc ^ v, 0)
  const num      = Math.abs(combined) % 100_000_000   // 8 dígitos max
  return String(num).padStart(8, '0')
}

// ── Helpers de formatação ─────────────────────────────────────────────────────

function onlyDigits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

/** Monta objeto ItauPessoa a partir dos dados da empresa (sempre PJ na Veramo) */
function buildPessoa(company: CompanyContext): ItauPessoa {
  return {
    tipo_pessoa: 'J',
    nome_pessoa: truncate(company.legal_name, 45),
    numero_cnpj: onlyDigits(company.cnpj),
  }
}

/**
 * Monta ItauEndereco a partir dos campos de endereço da empresa.
 * Fallbacks para campos vazios — o Itaú rejeita campos em branco,
 * então usamos 'NAO INFORMADO' quando o dado não existe no cadastro.
 */
function buildEndereco(company: CompanyContext): ItauEndereco {
  return {
    nome_logradouro:   truncate(company.address_line   ?? 'NAO INFORMADO', 45),
    numero_endereco:   truncate(company.address_number ?? 'S/N', 10),
    nome_complemento:  company.address_complement ? truncate(company.address_complement, 15) : undefined,
    nome_bairro:       truncate(company.neighborhood   ?? 'NAO INFORMADO', 30),
    nome_cidade:       truncate(company.city           ?? 'NAO INFORMADO', 25),
    sigla_UF:          (company.state ?? 'SP').slice(0, 2).toUpperCase(),
    numero_CEP:        onlyDigits(company.zip_code ?? '00000000').padEnd(8, '0').slice(0, 8),
  }
}

/**
 * Monta as linhas de mensagem do boleto.
 * Itaú aceita até 5 linhas de ~75 chars. [VERIFICAR LEGADO: limite exato]
 */
function buildMensagem(appointment: AppointmentContext): { linha_mensagem: string[] } {
  return {
    linha_mensagem: [
      `Homologacao Trabalhista - Veramo`,
      `Protocolo: ${appointment.protocol}`,
      `Funcionario: ${truncate(appointment.employee_name, 60)}`,
    ],
  }
}

// ── Mapper principal ──────────────────────────────────────────────────────────

/**
 * Transforma dados Veramo em payload de criação de Bolecode.
 *
 * Não valida a presença dos campos obrigatórios do union — isso é
 * responsabilidade de quem chama (validateUnionItauConfig).
 */
export function mapToBolecodeRequest(input: BolecodeMapperInput): ItauBolecodeRequest {
  const { charge, appointment, company, union, dueDate } = input

  const dadosIndividuais: ItauDadosIndividuais = {
    nosso_numero:       generateNossoNumero(charge.id),
    data_vencimento:    dueDate,
    valor_total_titulo: charge.gross_amount,
    pagador: {
      pessoa:   buildPessoa(company),
      endereco: buildEndereco(company),
    },
    mensagem: buildMensagem(appointment),
  }

  return {
    beneficiario: {
      id_beneficiario: union.itau_beneficiario_id,
    },
    dados_individuais_boleto: [dadosIndividuais],
    dados_qrcode: {
      chave:                union.itau_pix_key,
      solicitacao_pagador:  `Homologacao ${appointment.protocol}`,
    },
  }
}

// ── Parser da resposta ────────────────────────────────────────────────────────

/**
 * Extrai os campos relevantes da resposta Itaú para salvar no banco.
 * Tolerante a campos ausentes — retorna null onde o Itaú não enviou dados.
 */
export function parseBolecodeResponse(res: ItauBolecodeResponse): BolecodeCreateResult {
  const item = res.dados_individuais_boleto?.[0]

  return {
    nossoNumero:    item?.nosso_numero    ?? '',
    txid:           item?.txid            ?? null,
    pixCopyPaste:   item?.emv_payload     ?? null,
    pixQrCode:      item?.qr_code_base64  ?? null,
    boletoUrl:      item?.url_boleto      ?? null,
    linhaDigitavel: item?.linha_digitavel ?? null,
    codigoBarras:   item?.codigo_de_barras ?? null,
    rawPayload:     res,
  }
}

// ── Validação de pré-condições ────────────────────────────────────────────────

export type ValidationError = { field: string; message: string }

/**
 * Valida se o sindicato tem todos os campos Itaú configurados.
 * Deve ser chamado antes de mapToBolecodeRequest para dar erro legível.
 */
export function validateUnionItauConfig(union: Partial<UnionItauContext>): ValidationError[] {
  const errors: ValidationError[] = []

  if (!union.itau_beneficiario_id)
    errors.push({ field: 'itau_beneficiario_id', message: 'Sindicato não tem beneficiario_id Itaú configurado.' })
  if (!union.itau_pix_key)
    errors.push({ field: 'itau_pix_key', message: 'Sindicato não tem chave PIX Itaú configurada.' })
  if (!union.itau_carteira_code)
    errors.push({ field: 'itau_carteira_code', message: 'Sindicato não tem código de carteira Itaú configurado.' })

  return errors
}

/**
 * Valida se a empresa tem endereço suficiente para o boleto.
 * O Itaú rejeita CEP inválido e cidade/estado vazios.
 */
export function validateCompanyAddress(company: CompanyContext): ValidationError[] {
  const errors: ValidationError[] = []
  const cep = onlyDigits(company.zip_code ?? '')

  if (cep.length !== 8)
    errors.push({ field: 'zip_code', message: `CEP da empresa inválido: "${company.zip_code}" (esperado 8 dígitos).` })
  if (!company.city)
    errors.push({ field: 'city', message: 'Cidade da empresa não cadastrada.' })
  if (!company.state)
    errors.push({ field: 'state', message: 'Estado (UF) da empresa não cadastrado.' })

  return errors
}

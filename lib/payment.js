import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { validateCustomer } from '../public/validation.js';

export const AMOUNT_CENTS = 28700;
export const PRODUCT_NAME = 'Black Vitalícia | Felipe Almeida';
const API_BASE = 'https://atlaspags.com/api/v1';

export class PaymentError extends Error {
  constructor(message, status = 502, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function getKey() {
  const key = process.env.ATLAS_SECRET_KEY?.trim();
  if (!key?.startsWith('atlas_sk_')) {
    throw new PaymentError('O Pix está temporariamente indisponível. Tente novamente mais tarde.', 503, true);
  }
  return key;
}

function signature(content) {
  return createHmac('sha256', getKey()).update('nutri-checkout-receipt-v1:').update(content).digest('base64url');
}

function validChargeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9._~-]{1,128}$/.test(id);
}

export function createReceipt(transactionId, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ transactionId, amount: AMOUNT_CENTS, expiresAt: now + 7 * 86400000 })).toString('base64url');
  return `${payload}.${signature(payload)}`;
}

export function readReceipt(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) throw new PaymentError('Referência de pagamento inválida.', 401);
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra) throw new PaymentError('Referência de pagamento inválida.', 401);
  const expected = Buffer.from(signature(payload));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new PaymentError('Referência de pagamento inválida.', 401);
  let receipt;
  try { receipt = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new PaymentError('Referência de pagamento inválida.', 401); }
  if (!validChargeId(receipt.transactionId) || receipt.amount !== AMOUNT_CENTS || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now) {
    throw new PaymentError('Referência de pagamento expirada ou inválida.', 401);
  }
  return receipt;
}

export function crc16(text) {
  let crc = 0xffff;
  for (const byte of Buffer.from(text, 'utf8')) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function validatePixCode(code) {
  if (typeof code !== 'string' || code.length > 4096 || !code.startsWith('000201') || !/6304[0-9a-f]{4}$/i.test(code) || crc16(code.slice(0, -4)) !== code.slice(-4).toUpperCase()) {
    throw new PaymentError('A cobrança foi solicitada, mas o código Pix não pôde ser validado. Não repita a compra; verifique com o vendedor.');
  }
  const bytes = Buffer.from(code, 'utf8');
  const fields = new Map();
  for (let offset = 0; offset < bytes.length;) {
    const tag = bytes.subarray(offset, offset + 2).toString();
    const lengthText = bytes.subarray(offset + 2, offset + 4).toString();
    if (!/^\d{2}$/.test(tag) || !/^\d{2}$/.test(lengthText)) throw new PaymentError('Código Pix inválido. Verifique com o vendedor.');
    const length = Number(lengthText);
    if (offset + 4 + length > bytes.length || fields.has(tag)) throw new PaymentError('Código Pix inválido. Verifique com o vendedor.');
    fields.set(tag, bytes.subarray(offset + 4, offset + 4 + length).toString('utf8'));
    offset += length + 4;
  }
  if (fields.get('53') !== '986' || fields.get('58') !== 'BR' || !code.toLowerCase().includes('br.gov.bcb.pix')) throw new PaymentError('Código Pix inválido. Verifique com o vendedor.');
  if (fields.has('54') && Math.round(Number(fields.get('54')) * 100) !== AMOUNT_CENTS) throw new PaymentError('O valor retornado não corresponde à compra. Verifique com o vendedor.');
  return code;
}

export function providerErrorDetails(body, requestBody = '') {
  let payload;
  try { payload = JSON.parse(body); } catch { return { reason: 'non_json_error_response' }; }
  const values = [process.env.ATLAS_SECRET_KEY];
  try {
    const customer = JSON.parse(requestBody).customer;
    if (customer) values.push(...Object.values(customer));
  } catch { /* GET calls have no customer body. */ }
  const redact = (value) => {
    if (typeof value !== 'string') return undefined;
    let text = value;
    for (const secret of values) {
      if (typeof secret === 'string' && secret.length >= 3) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/atlas_sk_[a-zA-Z0-9_-]+/g, '[redacted]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, '[redacted]')
      .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[redacted]')
      .replace(/\+?\d[\d\s().-]{8,}\d/g, '[redacted]').slice(0, 400);
  };
  const providerError = payload?.error;
  return {
    code: redact(typeof providerError === 'object' ? providerError.code : undefined),
    message: redact(typeof payload?.detail === 'string' ? payload.detail : typeof providerError === 'object' ? providerError.message : undefined),
    fields: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
  };
}

async function atlas(path, options = {}, fetchImpl = fetch) {
  const key = getKey();
  const headers = { accept: 'application/json', authorization: `Bearer ${key}` };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(options.body));
  }
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  let response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: options.body } : {}),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
  } catch {
    // A repeat uses the same Idempotency-Key, so an uncertain request is safe to retry.
    throw new PaymentError('Não foi possível confirmar a resposta da cobrança. Tente novamente com segurança.', 502, true);
  }
  const text = await response.text();
  if (text.length > 65536) throw new PaymentError('Resposta inválida do serviço de pagamento. Verifique com o vendedor.');
  let payload;
  try { payload = JSON.parse(text); } catch { throw new PaymentError('Resposta inválida do serviço de pagamento. Verifique com o vendedor.'); }
  if (!response.ok) {
    const details = providerErrorDetails(text, options.body);
    console.error('atlas_http_error', { status: response.status, operation: options.method === 'POST' ? 'create' : 'status', code: details.code ?? 'provider_error' });
    if (response.status === 401 || response.status === 403) throw new PaymentError('A conta Atlas Pags não está autorizada para esta operação. Verifique a chave e a habilitação da conta.', 503, true);
    if (response.status === 400 || response.status === 422) throw new PaymentError('A Atlas Pags recusou os dados da cobrança. Confira os dados do comprador.', 422, true);
    if (response.status === 429) throw new PaymentError('Muitas solicitações. Aguarde um instante e tente novamente.', 429, true);
    throw new PaymentError('A Atlas Pags não confirmou a operação. Verifique antes de tentar novamente.', 502, true);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new PaymentError('Resposta inválida do serviço de pagamento. Verifique com o vendedor.');
  return payload;
}

function normalizeStatus(status) {
  const statuses = { pending: 'pending', paid: 'paid', failed: 'cancelled', expired: 'expired', refunded: 'cancelled', chargeback: 'cancelled' };
  return statuses[status];
}

export async function createPayment(customerInput, storeUrl, fetchImpl = fetch, idempotencyKey = randomUUID()) {
  const customer = validateCustomer(customerInput);
  if (!storeUrl.startsWith('https://')) throw new PaymentError('O checkout precisa de uma conexão segura.', 400, true);
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new PaymentError('Identificador da cobrança inválido.', 400, true);
  }
  const body = JSON.stringify({
    amount: AMOUNT_CENTS / 100,
    method: 'pix',
    description: PRODUCT_NAME,
    checkout_url: storeUrl,
    customer: {
      name: customer.name,
      email: customer.email,
      document: customer.document.replace(/\D/g, ''),
      phone: customer.phone,
    },
  });
  const result = await atlas('/charges', { method: 'POST', body, idempotencyKey }, fetchImpl);
  if (!validChargeId(result.id) || result.method !== 'pix' || !Number.isFinite(Number(result.amount)) || Math.round(Number(result.amount) * 100) !== AMOUNT_CENTS) {
    throw new PaymentError('A resposta da cobrança precisa ser verificada. Não repita a compra; entre em contato com o vendedor.');
  }
  const status = normalizeStatus(result.status);
  if (!status) throw new PaymentError('Status de pagamento ainda não reconhecido.');
  const copyPaste = validatePixCode(result.pix?.code);
  const qrCodeDataUrl = await QRCode.toDataURL(copyPaste, { errorCorrectionLevel: 'M', width: 448, margin: 4 });
  return {
    amount: AMOUNT_CENTS,
    copyPaste,
    qrCodeDataUrl,
    token: createReceipt(result.id),
    expiresAt: typeof result.pix?.expires_at === 'string' && Number.isFinite(Date.parse(result.pix.expires_at)) ? result.pix.expires_at : null,
    status,
  };
}

export async function getPaymentStatus(token, fetchImpl = fetch) {
  const receipt = readReceipt(token);
  const result = await atlas(`/charges/${encodeURIComponent(receipt.transactionId)}`, {}, fetchImpl);
  if (result.id !== receipt.transactionId || result.method !== 'pix' || !Number.isFinite(Number(result.amount)) || Math.round(Number(result.amount) * 100) !== AMOUNT_CENTS) {
    throw new PaymentError('Não foi possível validar o status do pagamento.');
  }
  const status = normalizeStatus(result.status);
  if (!status) throw new PaymentError('Status de pagamento ainda não reconhecido.');
  return { status, amount: AMOUNT_CENTS };
}

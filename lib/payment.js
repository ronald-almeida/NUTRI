import { createHmac, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { validateCustomer } from '../public/validation.js';

export const AMOUNT_CENTS = 28700;
export const PRODUCT_NAME = 'Black Vitalícia | Felipe Almeida';
const API_BASE = 'https://firebotbr.com';

export class PaymentError extends Error {
  constructor(message, status = 502, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

function getKey() {
  const key = process.env.FIREBOT_API_KEY?.trim();
  if (!key?.startsWith('fire_sk_live_')) {
    throw new PaymentError('O Pix está temporariamente indisponível. Tente novamente mais tarde.', 503, true);
  }
  return key;
}

function signature(content) {
  return createHmac('sha256', getKey()).update('nutri-checkout-receipt-v1:').update(content).digest('base64url');
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
  if (!/^fire_tx_[a-zA-Z0-9_-]+$/.test(receipt.transactionId) || receipt.amount !== AMOUNT_CENTS || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now) {
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
  const values = [process.env.FIREBOT_API_KEY];
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
    return text.replace(/fire_(?:sk|pk|wk)_[a-zA-Z0-9_-]+/g, '[redacted]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, '[redacted]')
      .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[redacted]')
      .replace(/\+?\d[\d\s().-]{8,}\d/g, '[redacted]').slice(0, 400);
  };
  return {
    code: redact(payload?.code),
    message: redact(typeof payload?.error === 'string' ? payload.error : payload?.message),
    fields: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20) : [],
  };
}

async function firebot(path, options = {}, fetchImpl = fetch) {
  const key = getKey();
  let response;
  try {
    response = await fetchImpl(`${API_BASE}${path}`, {
      ...options,
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-api-key': key },
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    });
  } catch {
    // The API does not document idempotency. Never automatically retry a charge.
    throw new PaymentError('Não foi possível confirmar a resposta da cobrança. Não repita a compra agora; verifique com o vendedor.');
  }
  if (!response.ok) {
    const errorBody = (await response.text()).slice(0, 8192);
    console.error('firebot_http_error', {
      status: response.status,
      operation: options.method === 'POST' ? 'create' : 'status',
      ...providerErrorDetails(errorBody, options.body),
    });
    if (response.status === 401 || response.status === 403) throw new PaymentError('O Pix está temporariamente indisponível. Tente novamente mais tarde.', 503, true);
    if (response.status === 400 || response.status === 422) throw new PaymentError('O serviço de pagamento recusou a geração do Pix. Confira seus dados ou entre em contato com o vendedor.', 422, true);
    throw new PaymentError('A Firebot não confirmou a operação. Aguarde e verifique com o vendedor antes de repetir a compra.');
  }
  const text = await response.text();
  if (text.length > 65536) throw new PaymentError('Resposta inválida do serviço de pagamento. Verifique com o vendedor.');
  let payload;
  try { payload = JSON.parse(text); } catch { throw new PaymentError('Resposta inválida do serviço de pagamento. Verifique com o vendedor.'); }
  if (!payload || payload.success === false) throw new PaymentError('O serviço não confirmou a cobrança. Verifique com o vendedor antes de tentar novamente.');
  return payload;
}

export async function createPayment(customerInput, storeUrl, fetchImpl = fetch) {
  const customer = validateCustomer(customerInput);
  if (!storeUrl.startsWith('https://')) throw new PaymentError('O checkout precisa de uma conexão segura.', 400, true);
  const result = await firebot('/api/v1/pix/create', {
    method: 'POST',
    body: JSON.stringify({
      amount: AMOUNT_CENTS / 100,
      productType: 'DIGITAL',
      description: PRODUCT_NAME,
      storeUrl,
      qrStyle: 'plain',
      customer: { name: customer.name, email: customer.email, cpf: customer.document, phone: customer.phone },
    }),
  }, fetchImpl);
  if (result.success !== true || !/^fire_tx_[a-zA-Z0-9_-]+$/.test(result.transactionId) || !Number.isFinite(Number(result.amount)) || Math.round(Number(result.amount) * 100) !== AMOUNT_CENTS) {
    throw new PaymentError('A resposta da cobrança precisa ser verificada. Não repita a compra; entre em contato com o vendedor.');
  }
  const copyPaste = validatePixCode(result.pixCopiaECola);
  const qrCodeDataUrl = await QRCode.toDataURL(copyPaste, { errorCorrectionLevel: 'M', width: 448, margin: 4 });
  return {
    amount: AMOUNT_CENTS,
    copyPaste,
    qrCodeDataUrl,
    token: createReceipt(result.transactionId),
    expiresAt: typeof result.expiresAt === 'string' && Number.isFinite(Date.parse(result.expiresAt)) ? result.expiresAt : null,
    status: 'pending',
  };
}

export async function getPaymentStatus(token, fetchImpl = fetch) {
  const receipt = readReceipt(token);
  const result = await firebot(`/api/v1/pix/${encodeURIComponent(receipt.transactionId)}`, {}, fetchImpl);
  // Status response must identify the same charge before confirming money received.
  const transaction = result.transaction ?? result.data ?? result;
  if (transaction.transactionId !== receipt.transactionId || !Number.isFinite(Number(transaction.amount)) || Math.round(Number(transaction.amount) * 100) !== AMOUNT_CENTS) {
    throw new PaymentError('Não foi possível validar o status do pagamento.');
  }
  const statuses = { PAID: 'paid', PENDING: 'pending', CANCELLED: 'cancelled', EXPIRED: 'expired', REFUNDED: 'cancelled' };
  const status = statuses[transaction.status];
  if (!status) throw new PaymentError('Status de pagamento ainda não reconhecido.');
  return { status, amount: AMOUNT_CENTS };
}

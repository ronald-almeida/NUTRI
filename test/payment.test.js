import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayment, getPaymentStatus, createReceipt, readReceipt, crc16, validatePixCode } from '../lib/payment.js';
import { POST as createHandler } from '../api/pix.js';
import { POST as statusHandler } from '../api/pix-status.js';
import { isValidCpf } from '../public/validation.js';

// Synthetic fixtures only; tests never contact Firebot or create real charges.
process.env.FIREBOT_API_KEY = 'fire_sk_live_local_unit_test_not_a_real_key';
const customer = { name: 'Teste Local', email: 'teste@example.invalid', phone: '11999999999', document: '52998224725' };
const txId = 'fire_tx_local_test';
const field = (id, value) => `${id}${Buffer.byteLength(value).toString().padStart(2, '0')}${value}`;
function code(amount = '287.00') {
  const payload = field('00', '01') + field('26', field('00', 'br.gov.bcb.pix') + field('01', 'unit-test-only')) + field('52', '0000') + field('53', '986') + field('54', amount) + field('58', 'BR') + field('59', 'TESTE SEM VALOR') + field('60', 'TESTE') + '6304';
  return payload + crc16(payload);
}
const request = (path, data, origin = 'https://checkout.example') => new Request(`https://checkout.example${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(data) });
const success = (data) => Response.json({ success: true, ...data });

test('validates CPF checksums and rejects repeated digits', () => {
  assert.equal(isValidCpf(customer.document), true);
  assert.equal(isValidCpf('52998224724'), false);
  assert.equal(isValidCpf('11111111111'), false);
});
test('creates exactly R$ 287 with documented Firebot fields and server-only key', async () => {
  let calls = 0;
  const result = await createPayment({ ...customer, amount: 1 }, 'https://checkout.example/', async (url, options) => {
    calls++;
    assert.equal(url, 'https://firebotbr.com/api/v1/pix/create');
    assert.equal(options.headers['x-api-key'], process.env.FIREBOT_API_KEY);
    assert.deepEqual(JSON.parse(options.body), { amount: 287, productType: 'DIGITAL', description: 'Black Vitalícia | Felipe Almeida', storeUrl: 'https://checkout.example/', qrStyle: 'plain', customer: { name: customer.name, email: customer.email, phone: customer.phone, cpf: customer.document } });
    return success({ amount: 287, transactionId: txId, pixCopiaECola: code(), status: 'PENDING' });
  });
  assert.equal(calls, 1);
  assert.equal(result.amount, 28700);
  assert.match(result.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.equal(result.expiresAt, null);
  assert.equal(JSON.stringify(result).includes(process.env.FIREBOT_API_KEY), false);
  assert.equal(JSON.stringify(result).includes(customer.document), false);
});
test('rejects mismatched amount, corrupt QR CRC, and code amount mismatch', async () => {
  await assert.rejects(createPayment(customer, 'https://checkout.example/', async () => success({ amount: 1, transactionId: txId, pixCopiaECola: code() })));
  assert.throws(() => validatePixCode(code('1.00')));
  assert.throws(() => validatePixCode(code().slice(0, -4) + '0000'));
});
test('rejects tampered and expired receipt before calling provider', async () => {
  const receipt = createReceipt(txId, 1000);
  assert.equal(readReceipt(receipt, 2000).transactionId, txId);
  assert.throws(() => readReceipt(receipt, 8 * 86400000));
  const current = createReceipt(txId);
  let calls = 0;
  await assert.rejects(getPaymentStatus(`${current}tampered`, async () => { calls++; }));
  assert.equal(calls, 0);
});
test('confirms only matching transaction and amount; rejects unexpected states', async () => {
  const token = createReceipt(txId);
  assert.deepEqual(await getPaymentStatus(token, async () => success({ transactionId: txId, amount: 287, status: 'PAID' })), { status: 'paid', amount: 28700 });
  await assert.rejects(getPaymentStatus(token, async () => success({ transactionId: 'fire_tx_other', amount: 287, status: 'PAID' })));
  await assert.rejects(getPaymentStatus(token, async () => success({ transactionId: txId, amount: 1, status: 'PAID' })));
  await assert.rejects(getPaymentStatus(token, async () => success({ transactionId: txId, amount: 287, status: 'UNKNOWN' })));
});
test('does not retry uncertain charge requests', async () => {
  let calls = 0;
  await assert.rejects(createPayment(customer, 'https://checkout.example/', async () => { calls++; throw new Error('network timeout'); }), (error) => error.retryable === false);
  assert.equal(calls, 1);
});
test('rejects cross-origin requests and invalid buyer data without contacting Firebot', async () => {
  assert.equal((await createHandler(request('/api/pix', { customer }, 'https://attacker.invalid'))).status, 403);
  assert.equal((await createHandler(request('/api/pix', { customer: { ...customer, document: '11111111111' } }))).status, 400);
  assert.equal((await statusHandler(request('/api/pix-status', { token: 'not-a-receipt' }))).status, 401);
});
test('rejects oversized bodies and invalid JSON', async () => {
  assert.equal((await createHandler(request('/api/pix', { value: 'x'.repeat(5000) }))).status, 413);
  const response = await createHandler(new Request('https://checkout.example/api/pix', { method: 'POST', headers: { origin: 'https://checkout.example', 'content-type': 'application/json' }, body: '{' }));
  assert.equal(response.status, 400);
});
test('missing key fails closed, without revealing configuration', async () => {
  const original = process.env.FIREBOT_API_KEY;
  delete process.env.FIREBOT_API_KEY;
  try {
    const result = await createHandler(request('/api/pix', { customer }));
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal((await result.json()).retryable, true);
  } finally { process.env.FIREBOT_API_KEY = original; }
});

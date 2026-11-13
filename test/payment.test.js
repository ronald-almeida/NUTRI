import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayment, getPaymentStatus, createReceipt, readReceipt, crc16, validatePixCode, providerErrorDetails } from '../lib/payment.js';
import { POST as createHandler } from '../api/pix.js';
import { POST as statusHandler } from '../api/pix-status.js';
import { isValidCpf } from '../public/validation.js';

// Synthetic fixtures only; tests never contact Atlas Pags or create real charges.
process.env.ATLAS_SECRET_KEY = 'atlas_sk_test_local_unit_test_not_a_real_key';
const customer = { name: 'Teste Local', email: 'teste@example.invalid', phone: '11999999999', document: '52998224725' };
const txId = 'charge_local_test_123';
const field = (id, value) => `${id}${Buffer.byteLength(value).toString().padStart(2, '0')}${value}`;
function code(amount = '287.00') {
  const payload = field('00', '01') + field('26', field('00', 'br.gov.bcb.pix') + field('01', 'unit-test-only')) + field('52', '0000') + field('53', '986') + field('54', amount) + field('58', 'BR') + field('59', 'TESTE SEM VALOR') + field('60', 'TESTE') + '6304';
  return payload + crc16(payload);
}
const request = (path, data, origin = 'https://checkout.example') => new Request(`https://checkout.example${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'idempotency-key': 'nutri-test-order-1042' }, body: JSON.stringify(data) });
const charge = (data) => Response.json({ id: txId, object: 'charge', method: 'pix', amount: 287, status: 'pending', pix: { code: code(), expires_at: null }, ...data });

test('validates CPF checksums and rejects repeated digits', () => {
  assert.equal(isValidCpf(customer.document), true);
  assert.equal(isValidCpf('52998224724'), false);
  assert.equal(isValidCpf('11111111111'), false);
});
test('creates exactly R$ 287 with documented Atlas Pags fields and server-only key', async () => {
  let calls = 0;
  const result = await createPayment({ ...customer, amount: 1 }, 'https://checkout.example/', async (url, options) => {
    calls++;
    assert.equal(url, 'https://atlaspags.com/api/v1/charges');
    assert.equal(options.headers.authorization, `Bearer ${process.env.ATLAS_SECRET_KEY}`);
    assert.equal(options.headers['idempotency-key'], 'nutri-test-order-1042');
    assert.equal(options.headers['content-length'], String(Buffer.byteLength(options.body)));
    assert.deepEqual(JSON.parse(options.body), { amount: 287, method: 'pix', description: 'Black Vitalícia | Felipe Almeida', checkout_url: 'https://checkout.example/', customer: { name: customer.name, email: customer.email, phone: customer.phone, document: customer.document } });
    return charge({});
  }, 'nutri-test-order-1042');
  assert.equal(calls, 1);
  assert.equal(result.amount, 28700);
  assert.match(result.qrCodeDataUrl, /^data:image\/png;base64,/);
  assert.equal(result.expiresAt, null);
  assert.equal(JSON.stringify(result).includes(process.env.ATLAS_SECRET_KEY), false);
  assert.equal(JSON.stringify(result).includes(customer.document), false);
});
test('rejects mismatched amount, corrupt QR CRC, and code amount mismatch', async () => {
  await assert.rejects(createPayment(customer, 'https://checkout.example/', async () => charge({ amount: 1 })));
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
  assert.deepEqual(await getPaymentStatus(token, async () => charge({ status: 'paid' })), { status: 'paid', amount: 28700 });
  await assert.rejects(getPaymentStatus(token, async () => charge({ id: 'charge_other_456', status: 'paid' })));
  await assert.rejects(getPaymentStatus(token, async () => charge({ amount: 1, status: 'paid' })));
  await assert.rejects(getPaymentStatus(token, async () => charge({ status: 'unknown' })));
});
test('does not retry uncertain charge requests', async () => {
  let calls = 0;
  await assert.rejects(createPayment(customer, 'https://checkout.example/', async () => { calls++; throw new Error('network timeout'); }), (error) => error.retryable === true);
  assert.equal(calls, 1);
});
test('rejects cross-origin requests and invalid buyer data without contacting Atlas Pags', async () => {
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
  const original = process.env.ATLAS_SECRET_KEY;
  delete process.env.ATLAS_SECRET_KEY;
  try {
    const result = await createHandler(request('/api/pix', { customer }));
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal((await result.json()).retryable, true);
  } finally { process.env.ATLAS_SECRET_KEY = original; }
});
test('provider diagnostics redact buyer information and credentials', () => {
  const message = `CPF 529.982.247-25, telefone (11) 99999-9999, ${customer.name}, ${customer.email}, ${process.env.ATLAS_SECRET_KEY}: gateway indisponível`;
  const result = providerErrorDetails(JSON.stringify({ detail: message, error: { code: 'validation_error', message } }), JSON.stringify({ customer }));
  for (const value of [...Object.values(customer), process.env.ATLAS_SECRET_KEY, '529.982.247-25', '(11) 99999-9999']) assert.equal(JSON.stringify(result).includes(value), false);
  assert.match(result.message, /gateway indisponível/);
});

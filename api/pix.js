import { createPayment, PaymentError } from '../lib/payment.js';
import { validateCustomer } from '../public/validation.js';
import { readRequest, json, handleError } from '../lib/http.js';

export async function POST(request) {
  try {
    const body = await readRequest(request);
    let customer;
    try { customer = validateCustomer(body?.customer); }
    catch (error) { throw new PaymentError(error.message, 400, true); }
    const idempotencyKey = request.headers.get('idempotency-key');
    if (!idempotencyKey || idempotencyKey.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      throw new PaymentError('Identificador da cobrança inválido. Atualize a página e tente novamente.', 400, true);
    }
    const storeUrl = process.env.STORE_URL || `${new URL(request.url).origin}/`;
    return json(await createPayment(customer, storeUrl, fetch, idempotencyKey));
  } catch (error) { return handleError(error); }
}

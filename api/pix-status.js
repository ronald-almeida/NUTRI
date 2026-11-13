import { getPaymentStatus } from '../lib/payment.js';
import { readRequest, json, handleError } from '../lib/http.js';

export async function POST(request) {
  try {
    const body = await readRequest(request);
    return json(await getPaymentStatus(body?.token));
  } catch (error) { return handleError(error); }
}

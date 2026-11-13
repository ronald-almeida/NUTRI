import { PaymentError } from './payment.js';

export function json(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' } });
}

export async function readRequest(request) {
  if (request.method !== 'POST') throw new PaymentError('Método não permitido.', 405);
  const origin = request.headers.get('origin');
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new PaymentError('Origem não autorizada.', 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new PaymentError('Formato de requisição inválido.', 415);
  const reader = request.body?.getReader();
  if (!reader) throw new PaymentError('Dados ausentes.', 400, true);
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4096) { await reader.cancel(); throw new PaymentError('Requisição muito grande.', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new PaymentError('Dados inválidos.', 400, true); }
}

export function handleError(error) {
  if (error instanceof PaymentError) return json({ error: error.message, retryable: error.retryable }, error.status);
  console.error('checkout_error', { type: error?.name ?? 'UnknownError' });
  return json({ error: 'Não foi possível concluir a operação. Verifique com o vendedor antes de tentar novamente.', retryable: false }, 500);
}

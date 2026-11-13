import { digits, validateCustomer } from './validation.js';

const $ = (id) => document.getElementById(id);
const dialog = $('pix-dialog');
const form = $('checkout-form');
let request = null;
let charge = null;
let generating = false;
let pollTimer;
let expiryTimer;
let checking = false;
let uncertain = false;
const STORAGE_KEY = 'nutri.pix.checkout.v1';
const UNCERTAIN_MESSAGE = 'Uma cobrança foi solicitada, mas ainda não foi possível confirmar a resposta. Não repita a compra agora; verifique com o vendedor.';
const views = ['payment-loading', 'payment-ready', 'payment-error', 'payment-confirmed'];

function saveSession(value) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Private mode: keep state only in this tab's memory. */ }
}
function clearSession() { try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage unavailable. */ } }

document.querySelector('.details-button').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const expanded = button.getAttribute('aria-expanded') === 'true';
  button.setAttribute('aria-expanded', String(!expanded));
  $('purchase-details').hidden = expanded;
});

$('document').addEventListener('input', (event) => {
  const cpf = digits(event.target.value).slice(0, 11);
  event.target.value = cpf.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
});

function showView(id) {
  for (const view of views) $(view).hidden = view !== id;
}

function showError(message) {
  stopPolling();
  $('payment-error-text').textContent = message;
  showView('payment-error');
}

function stopPolling() {
  clearTimeout(pollTimer);
  clearInterval(expiryTimer);
}

function closeDialog() { dialog.close(); }
$('close-dialog').addEventListener('click', closeDialog);
$('done-button').addEventListener('click', closeDialog);
dialog.addEventListener('close', stopPolling);
dialog.addEventListener('click', (event) => {
  const bounds = dialog.getBoundingClientRect();
  if (event.target === dialog && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) closeDialog();
});

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error || 'O pagamento está temporariamente indisponível. Tente novamente em alguns instantes.');
    error.retryable = body?.retryable === true;
    throw error;
  }
  return body;
}

function updateExpiration() {
  const expiresAt = Date.parse(charge?.expiresAt ?? '');
  if (!Number.isFinite(expiresAt)) { $('expiration').hidden = true; return; }
  const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
  $('expiration').hidden = false;
  $('expiration').textContent = `Este código expira em ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  if (seconds === 0) {
    $('copy-button').disabled = true;
    $('expiration').textContent = 'Prazo do código encerrado. Verificando pagamento…';
    clearInterval(expiryTimer);
  }
}

async function checkPayment() {
  if (!charge || !dialog.open || checking) return;
  checking = true;
  try {
    const state = await api('/api/pix-status', { method: 'POST', body: JSON.stringify({ token: charge.token }) });
    if (state.status === 'paid') {
      charge.status = 'paid';
      stopPolling();
      showView('payment-confirmed');
      return;
    }
    if (state.status === 'expired' || state.status === 'cancelled') {
      charge = null;
      request = null;
      clearSession();
      showError('Este Pix não está mais disponível. Feche esta janela e tente novamente para gerar uma nova cobrança.');
      $('retry-button').hidden = true;
      return;
    }
    $('payment-status').textContent = 'Aguardando pagamento';
  } catch {
    $('payment-status').textContent = 'Não foi possível consultar agora. Tentaremos novamente.';
  } finally {
    checking = false;
  }
  if (dialog.open) pollTimer = setTimeout(checkPayment, 6000);
}

function showCharge() {
  stopPolling();
  if (charge.status === 'paid') { showView('payment-confirmed'); return; }
  $('qr-image').src = charge.qrCodeDataUrl;
  $('pix-code').value = charge.copyPaste;
  $('copy-status').textContent = '';
  $('copy-button').disabled = false;
  $('copy-button').textContent = 'Copiar código Pix';
  showView('payment-ready');
  updateExpiration();
  expiryTimer = setInterval(updateExpiration, 1000);
  void checkPayment();
}

async function generatePix() {
  if (generating || !request || uncertain) return;
  generating = true;
  $('buy-button').disabled = true;
  $('retry-button').hidden = false;
  showView('payment-loading');
  saveSession({ state: 'attempting' });
  try {
    const result = await api('/api/pix', { method: 'POST', body: JSON.stringify(request) });
    if (result.amount !== 28700 || !result.token || typeof result.copyPaste !== 'string' || !result.copyPaste || typeof result.qrCodeDataUrl !== 'string' || !result.qrCodeDataUrl.startsWith('data:image/png;base64,')) {
      throw new Error('Não foi possível validar o código Pix. Tente novamente em alguns instantes.');
    }
    charge = result;
    saveSession({ state: 'created', charge });
    if (dialog.open) showCharge();
  } catch (error) {
    uncertain = error.retryable !== true;
    if (uncertain) saveSession({ state: 'uncertain' });
    else clearSession();
    showError(error.name === 'TimeoutError' || error.name === 'TypeError' ? UNCERTAIN_MESSAGE : error.message);
    $('retry-button').hidden = uncertain;
  } finally {
    generating = false;
    $('buy-button').disabled = false;
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  $('form-error').hidden = true;
  try {
    const customer = validateCustomer(Object.fromEntries(new FormData(form)));
    // Firebot does not document idempotency. Keep the existing charge and block
    // retries after ambiguous responses instead of risking a second charge.
    if (!charge && !generating && !uncertain) request = { customer };
    dialog.showModal();
    if (uncertain) { showError(UNCERTAIN_MESSAGE); $('retry-button').hidden = true; }
    else if (charge) showCharge();
    else if (generating) showView('payment-loading');
    else void generatePix();
  } catch (error) {
    $('form-error').textContent = error.message;
    $('form-error').hidden = false;
  }
});
$('retry-button').addEventListener('click', () => void generatePix());
$('copy-button').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('pix-code').value);
    $('copy-button').textContent = 'Código copiado!';
    $('copy-status').textContent = 'Agora cole no aplicativo do seu banco.';
  } catch {
    $('pix-code').focus();
    $('pix-code').select();
    $('copy-status').textContent = 'Selecione e copie o código acima para usar no seu banco.';
  }
});

try {
  const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
  if (saved?.state === 'attempting' || saved?.state === 'uncertain') uncertain = true;
  if (saved?.state === 'created' && saved.charge?.amount === 28700 && typeof saved.charge?.token === 'string' && typeof saved.charge?.copyPaste === 'string' && saved.charge?.qrCodeDataUrl?.startsWith('data:image/png;base64,')) {
    charge = { ...saved.charge, status: 'pending' };
    dialog.showModal();
    showCharge();
  }
} catch { /* An invalid or unavailable saved session is ignored. */ }

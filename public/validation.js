export function digits(value) { return String(value ?? '').replace(/\D/g, ''); }

export function isValidCpf(value) {
  const cpf = digits(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1+$/.test(cpf)) return false;
  for (let length = 9; length <= 10; length++) {
    let sum = 0;
    for (let index = 0; index < length; index++) sum += Number(cpf[index]) * (length + 1 - index);
    const check = (sum * 10) % 11;
    if ((check === 10 ? 0 : check) !== Number(cpf[length])) return false;
  }
  return true;
}

export function validateCustomer(data) {
  if (!data || typeof data !== 'object') throw new Error('Confira seus dados e tente novamente.');
  const name = String(data.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(data.email ?? '').trim().toLowerCase();
  const phone = digits(data.phone);
  const document = digits(data.document);
  if (name.length < 3 || name.length > 120 || !/\S+\s+\S+/.test(name)) throw new Error('Informe seu nome completo.');
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Informe um email válido.');
  if (!/^[1-9]{2}\d{8,9}$/.test(phone)) throw new Error('Informe seu telefone com DDD.');
  if (!isValidCpf(document)) throw new Error('Confira o CPF informado.');
  return { name, email, phone, document };
}

import { formatMinor, type MinorUnits } from './money';

export interface UpiPayLink {
  /** Payee UPI ID (VPA), e.g. name@okaxis. */
  vpa: string;
  /** Payee name as shown by the UPI app. */
  name: string;
  /** Amount in paise. UPI is rupees only. */
  amountMinor: MinorUnits;
  /** Short note shown to both sides (trimmed to 50 characters). */
  note?: string;
  /** Your reference for this payment (letters and digits, at most 35). */
  ref?: string;
}

const VPA = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.-]{1,63}$/;
const REF = /^[A-Za-z0-9]{1,35}$/;

/**
 * Builds a `upi://pay` deep link (NPCI's common format, opened by GPay, PhonePe, Paytm and
 * other UPI apps) with the payee, amount, currency, note and reference filled in.
 */
export function upiPayUri(link: UpiPayLink): string {
  if (!VPA.test(link.vpa)) throw new RangeError(`not a valid UPI ID: ${link.vpa}`);
  if (!Number.isSafeInteger(link.amountMinor) || link.amountMinor <= 0) {
    throw new RangeError('amount must be a positive number of paise');
  }
  if (link.ref !== undefined && !REF.test(link.ref)) {
    throw new RangeError('reference must be 1-35 letters or digits');
  }
  const params = [
    ['pa', link.vpa],
    ['pn', link.name.trim().slice(0, 50) || 'Payee'],
    ['am', formatMinor(link.amountMinor, 'INR')],
    ['cu', 'INR'],
    ...(link.note?.trim() ? [['tn', link.note.trim().slice(0, 50)]] : []),
    ...(link.ref ? [['tr', link.ref]] : []),
  ];
  // encodeURIComponent, not URLSearchParams: some UPI apps don't decode '+' as a space
  return `upi://pay?${params.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&')}`;
}

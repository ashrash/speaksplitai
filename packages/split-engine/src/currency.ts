/**
 * ISO 4217 currencies and their minor-unit exponent: the number of decimal places between the
 * major unit and the smallest unit amounts are stored in (INR 2 = paise, JPY 0 = yen,
 * KWD 3 = fils). Mirrors the `currencies` table seeded by the initial migration; keep both in sync.
 */
export const CURRENCIES = {
  AED: { minorUnit: 2, name: 'UAE Dirham' },
  AUD: { minorUnit: 2, name: 'Australian Dollar' },
  BDT: { minorUnit: 2, name: 'Bangladeshi Taka' },
  BHD: { minorUnit: 3, name: 'Bahraini Dinar' },
  BTN: { minorUnit: 2, name: 'Bhutanese Ngultrum' },
  CAD: { minorUnit: 2, name: 'Canadian Dollar' },
  CHF: { minorUnit: 2, name: 'Swiss Franc' },
  CNY: { minorUnit: 2, name: 'Chinese Yuan' },
  EUR: { minorUnit: 2, name: 'Euro' },
  GBP: { minorUnit: 2, name: 'Pound Sterling' },
  HKD: { minorUnit: 2, name: 'Hong Kong Dollar' },
  IDR: { minorUnit: 2, name: 'Indonesian Rupiah' },
  INR: { minorUnit: 2, name: 'Indian Rupee' },
  JPY: { minorUnit: 0, name: 'Japanese Yen' },
  KRW: { minorUnit: 0, name: 'South Korean Won' },
  KWD: { minorUnit: 3, name: 'Kuwaiti Dinar' },
  LKR: { minorUnit: 2, name: 'Sri Lankan Rupee' },
  MVR: { minorUnit: 2, name: 'Maldivian Rufiyaa' },
  MYR: { minorUnit: 2, name: 'Malaysian Ringgit' },
  NPR: { minorUnit: 2, name: 'Nepalese Rupee' },
  NZD: { minorUnit: 2, name: 'New Zealand Dollar' },
  OMR: { minorUnit: 3, name: 'Omani Rial' },
  PHP: { minorUnit: 2, name: 'Philippine Peso' },
  QAR: { minorUnit: 2, name: 'Qatari Riyal' },
  SAR: { minorUnit: 2, name: 'Saudi Riyal' },
  SGD: { minorUnit: 2, name: 'Singapore Dollar' },
  THB: { minorUnit: 2, name: 'Thai Baht' },
  USD: { minorUnit: 2, name: 'US Dollar' },
  VND: { minorUnit: 0, name: 'Vietnamese Dong' },
  ZAR: { minorUnit: 2, name: 'South African Rand' },
} as const satisfies Record<string, { minorUnit: number; name: string }>;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export function isCurrencyCode(code: string): code is CurrencyCode {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code);
}

export function minorUnitOf(code: string): number {
  if (!isCurrencyCode(code)) {
    throw new RangeError(`unsupported currency: ${code}`);
  }
  return CURRENCIES[code].minorUnit;
}

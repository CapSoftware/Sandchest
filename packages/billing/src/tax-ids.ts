/**
 * Which kind of tax ID a business in a country puts on its invoices, as
 * Stripe names it, and what people there call it. Countries not listed
 * don't get a tax ID field.
 */
const EU = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];

const TYPES: Record<string, { type: string; label: string; example: string }> = {
  ...Object.fromEntries(EU.map((country) => [country, { type: "eu_vat", label: "VAT number", example: `${country === "GR" ? "EL" : country}123456789` }])),
  GB: { type: "gb_vat", label: "VAT number", example: "GB123456789" },
  CH: { type: "ch_vat", label: "VAT number", example: "CHE-123.456.789 MWST" },
  NO: { type: "no_vat", label: "VAT number", example: "123456789MVA" },
  IS: { type: "is_vat", label: "VAT number", example: "123456" },
  ZA: { type: "za_vat", label: "VAT number", example: "4123456789" },
  IL: { type: "il_vat", label: "VAT number", example: "000012345" },
  US: { type: "us_ein", label: "EIN", example: "12-3456789" },
  CA: { type: "ca_bn", label: "Business number", example: "123456789" },
  AU: { type: "au_abn", label: "ABN", example: "12345678912" },
  NZ: { type: "nz_gst", label: "GST number", example: "123456789" },
  IN: { type: "in_gst", label: "GSTIN", example: "12ABCDE3456FGZH" },
  SG: { type: "sg_gst", label: "GST number", example: "M12345678X" },
  JP: { type: "jp_trn", label: "Registration number", example: "T1234567891234" },
  KR: { type: "kr_brn", label: "Business registration number", example: "123-45-67890" },
  BR: { type: "br_cnpj", label: "CNPJ", example: "01.234.456/5432-10" },
  MX: { type: "mx_rfc", label: "RFC", example: "ABC010203AB9" },
  AE: { type: "ae_trn", label: "TRN", example: "123456789012345" },
};

export function taxIdFor(country: string | null | undefined): { type: string; label: string; example: string } | undefined {
  return country ? TYPES[country.toUpperCase()] : undefined;
}

/** Whether Stripe would read this as the tax ID type for the country. */
export function taxIdTypeFor(country: string, type: string): boolean {
  return taxIdFor(country)?.type === type;
}

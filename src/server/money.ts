// Money is kept in integer US cents and written as dollars only at the edges.

// A dollar amount typed by a Developer, such as "10" or "12.50", in cents; undefined if it is not one.
export function centsOf(dollars: unknown): number | undefined {
  if (typeof dollars !== "string" || !/^\d{1,9}(\.\d{1,2})?$/.test(dollars.trim())) return undefined;
  return Math.round(Number(dollars) * 100);
}

// Cents as PayPal's decimal string, e.g. 1250 → "12.50".
export const decimal = (cents: number) => (cents / 100).toFixed(2);

// Cents for people to read, e.g. 1250 → "$12.50".
export const dollars = (cents: number) => `$${decimal(cents)}`;

export function validImei(value: string): boolean {
  return /^[0-9]{15}$/.test(value) && !/^0+$/.test(value);
}

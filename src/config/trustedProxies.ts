import { isIP } from "node:net";

// Only explicit proxy addresses/networks. Never trust every peer or a client header.
export function trustedProxies(value = process.env.TRUSTED_PROXY_CIDRS): false | string[] {
  if (!value?.trim()) return false;
  const entries=value.split(',').map(v=>v.trim());
  for(const entry of entries) {
    const [address,prefix,...extra]=entry.split('/');
    const family=isIP(address);
    if(!family || extra.length || (prefix!==undefined && (!/^\d+$/.test(prefix) || Number(prefix)<1 || Number(prefix)>(family===4?32:128)))) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit IP addresses or nonzero CIDR networks.');
    }
  }
  return entries;
}

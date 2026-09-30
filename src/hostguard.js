import net from 'node:net';

function parseCidr(entry) {
  const [address, prefix] = entry.split('/');
  const version = net.isIP(address);
  if (version !== 4) return null;
  const bits = Number(prefix);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return {
    entry,
    network: ipv4ToInt(address),
    mask: bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0,
  };
}

function ipv4ToInt(address) {
  return address
    .split('.')
    .reduce((acc, part) => ((acc << 8) + Number(part)) >>> 0, 0);
}

function intToIpv4(value) {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

export { intToIpv4 };

export function classifyAllowedHosts(entries) {
  const exact = [];
  const networks = [];
  let wildcard = false;
  for (const entry of entries ?? []) {
    if (entry === '*') {
      wildcard = true;
      continue;
    }
    const cidr = parseCidr(entry);
    if (cidr) networks.push(cidr);
    else exact.push(entry);
  }
  return { exact, networks, wildcard, needsCustomGuard: networks.length > 0 || wildcard };
}

function hostnameFrom(value) {
  if (!value) return null;
  const raw = value.trim();
  try {
    return new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function hostnameFromOrigin(value) {
  try {
    return new URL(value).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function hostIsAllowed(hostname, policy) {
  if (!hostname) return false;
  if (policy.wildcard) return true;
  if (policy.exact.includes(hostname)) return true;
  if (policy.exact.includes(hostname.toLowerCase())) return true;
  if (policy.networks.length > 0 && net.isIP(hostname) === 4) {
    const value = ipv4ToInt(hostname);
    for (const network of policy.networks) {
      if ((value & network.mask) >>> 0 === (network.network & network.mask) >>> 0) return true;
    }
  }
  return false;
}

function refuse(res, message) {
  res.status(403).json({
    jsonrpc: '2.0',
    error: { code: -32000, message },
    id: null,
  });
}

export function hostHeaderGuard(entries) {
  const policy = classifyAllowedHosts(entries);
  return (req, res, next) => {
    const hostname = hostnameFrom(req.headers.host);
    if (!hostIsAllowed(hostname, policy)) {
      refuse(res, hostname ? `Invalid Host: ${hostname}` : 'Missing or unparsable Host header');
      return;
    }
    next();
  };
}

export function originGuard(entries) {
  const policy = classifyAllowedHosts(entries);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const hostname = hostnameFromOrigin(origin);
    if (!hostIsAllowed(hostname, policy)) {
      refuse(res, hostname ? `Invalid Origin: ${hostname}` : `Unparsable Origin: ${origin}`);
      return;
    }
    next();
  };
}

export function describePolicy(entries, addresses) {
  const policy = classifyAllowedHosts(entries);
  const parts = [];
  if (policy.wildcard) parts.push('any Host header (DNS-rebinding protection is off)');
  if (policy.networks.length > 0) {
    parts.push(`any host in ${policy.networks.map((network) => network.entry).join(', ')}`);
  }
  if (policy.exact.length > 0) parts.push(`hostnames ${policy.exact.join(', ')}`);
  if (addresses.length > 0) parts.push(`this device answers on ${addresses.join(', ')}`);
  return parts.join('; ');
}

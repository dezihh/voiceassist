import { createVerify, X509Certificate } from 'node:crypto';

export interface AlexaVerifyResult {
  ok: boolean;
  reason: string;
}

const certCache = new Map<string, { pem: string; fetchedAt: number }>();
const CERT_TTL_MS = 60 * 60 * 1000;
const TIMESTAMP_TOLERANCE_MS = 150_000;

function isAllowedCertUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      u.protocol === 'https:' &&
      (u.port === '443' || u.port === '8443' || u.port === '') &&
      (u.hostname === 's3.amazonaws.com' || u.hostname.endsWith('.amazonaws.com')) &&
      u.pathname.startsWith('/echo.api/')
    );
  } catch {
    return false;
  }
}

async function fetchChain(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < CERT_TTL_MS) return cached.pem;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`cert fetch HTTP ${res.status}`);
  const pem = await res.text();
  certCache.set(url, { pem, fetchedAt: Date.now() });
  return pem;
}

function splitPems(pem: string): string[] {
  const parts: string[] = [];
  const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
  for (const m of pem.matchAll(re)) parts.push(m[0]);
  return parts;
}

function datesValid(cert: X509Certificate): boolean {
  const now = Date.now();
  const from = new Date(cert.validFromDate).getTime();
  const to = new Date(cert.validToDate).getTime();
  return now >= from && now <= to;
}

export async function verifyAlexaSignature(
  rawBody: Buffer | undefined,
  signatureB64: string | undefined,
  certChainUrl: string | undefined,
  requestTimestamp: string | undefined
): Promise<AlexaVerifyResult> {
  if (!rawBody || rawBody.length === 0) return { ok: false, reason: 'rawBody fehlt' };
  if (!signatureB64 || !certChainUrl) return { ok: false, reason: 'Signature-Header fehlen' };
  if (!isAllowedCertUrl(certChainUrl)) return { ok: false, reason: 'CertChainUrl nicht erlaubt' };

  if (requestTimestamp) {
    const ts = Date.parse(requestTimestamp);
    if (Number.isNaN(ts)) return { ok: false, reason: 'Timestamp unparsebar' };
    if (Math.abs(Date.now() - ts) > TIMESTAMP_TOLERANCE_MS) {
      return { ok: false, reason: 'Timestamp ausserhalb Toleranz' };
    }
  }

  let pem: string;
  try {
    pem = await fetchChain(certChainUrl);
  } catch (e) {
    return { ok: false, reason: `Chain-Fetch fehlgeschlagen: ${String(e)}` };
  }

  const certs = splitPems(pem);
  if (certs.length === 0) return { ok: false, reason: 'kein Zertifikat in Chain' };
  const leaf = new X509Certificate(certs[0]);
  if (!datesValid(leaf)) return { ok: false, reason: 'Leaf-Zertifikat ausserhalb Gueltigkeit' };

  for (let i = 0; i < certs.length - 1; i++) {
    const child = new X509Certificate(certs[i]);
    const parent = new X509Certificate(certs[i + 1]);
    if (child.issuer !== parent.subject) return { ok: false, reason: 'Chain-Struktur inkonsistent' };
  }

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureB64, 'base64');
  } catch {
    return { ok: false, reason: 'Signature nicht base64' };
  }

  const verified = createVerify('RSA-SHA1').update(rawBody).verify(leaf.publicKey, signature);
  return verified
    ? { ok: true, reason: 'ok' }
    : { ok: false, reason: 'Signatur ungueltig' };
}

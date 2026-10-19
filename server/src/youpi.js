/**
 * The two ways this server talks to YouPI PG, and the one way YouPI talks back.
 *
 *   createPayment  — open a checkout session for a registration's order
 *   getPayment     — ask what happened to it (merchant view, authenticated)
 *   verifyWebhook  — check a SUCCESS notification really came from YouPI
 *
 * Nothing the browser says about a payment is believed. A ticket is issued
 * only from one of the last two, and only when the amount matches.
 */
import crypto from 'node:crypto';

export class YoupiError extends Error {}

export function createYoupiClient({ apiUrl, merchantId, webhookSecret }, fetchImpl = fetch) {
  async function call(path, init) {
    let res;
    try {
      res = await fetchImpl(apiUrl + path, { ...init, signal: AbortSignal.timeout(10000) });
    } catch (err) {
      throw new YoupiError(`YouPI is not reachable: ${err.message}`);
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 200) }; }
    if (!res.ok) throw new YoupiError(`YouPI answered ${res.status}: ${body.error || body.message || 'unknown error'}`);
    return body;
  }

  return {
    /**
     * YouPI answers a repeat call for the same order with the session already
     * open, or a fresh one (with a "-R1234" suffix on the order id) once the
     * last attempt has expired, so this doubles as "let me try paying again".
     */
    createPayment({ orderId, amountPaise, currency, customer, metadata, returnUrl }) {
      return call('/api/v1/payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Merchant-Id': merchantId },
        body: JSON.stringify({
          orderId,
          amount: (amountPaise / 100).toFixed(2),
          currency,
          method: 'UPI',
          customer,
          metadata,
          returnUrl
        })
      });
    },

    getPayment(paymentId) {
      return call(`/api/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { 'X-Merchant-Key': webhookSecret }
      });
    },

    /** Over the raw bytes, exactly as sent: re-serialised JSON would not match. */
    verifyWebhook(rawBody, signatureHeader) {
      const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
      const presented = Buffer.from(String(signatureHeader || ''));
      const wanted = Buffer.from(expected);
      return presented.length === wanted.length && crypto.timingSafeEqual(presented, wanted);
    }
  };
}

/** YouPI appends "-R<4 digits>" to an order id when it opens a retry session. */
export function baseOrderId(orderId) {
  return String(orderId || '').replace(/-R\d{4}$/, '');
}

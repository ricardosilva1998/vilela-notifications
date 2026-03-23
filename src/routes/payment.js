const { Router } = require('express');
const config = require('../config');
const db = require('../db');

const router = Router();

// --- PayPal API helpers ---

async function getPayPalToken() {
  const auth = Buffer.from(`${config.paypal.clientId}:${config.paypal.clientSecret}`).toString('base64');
  const res = await fetch(`${config.paypal.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  return data.access_token;
}

async function createPayPalOrder(amount, description) {
  const token = await getPayPalToken();
  const res = await fetch(`${config.paypal.baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{
        amount: { currency_code: 'EUR', value: amount.toFixed(2) },
        description,
      }],
      application_context: {
        return_url: `${config.app.url}/payment/success`,
        cancel_url: `${config.app.url}/payment/cancel`,
        brand_name: 'Atleta',
        user_action: 'PAY_NOW',
      },
    }),
  });
  return res.json();
}

async function capturePayPalOrder(orderId) {
  const token = await getPayPalToken();
  const res = await fetch(`${config.paypal.baseUrl}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.json();
}

// --- Pricing page (public) ---

router.get('/', (req, res) => {
  res.render('pricing', {
    streamer: req.streamer || null,
    tiers: config.tiers,
    currentTier: req.streamer ? db.getStreamerTier(req.streamer.id) : null,
  });
});

// --- Create payment ---

router.post('/create', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');

  const { tier, discount_code } = req.body;
  const tierConfig = config.tiers[tier];
  if (!tierConfig || tier === 'free') return res.redirect('/pricing');

  let price = tierConfig.price;
  let discountPercent = 0;
  let discountCodeUsed = null;

  // Apply discount code
  if (discount_code) {
    const code = db.getDiscountCode(discount_code);
    if (code) {
      discountPercent = code.discount_percent;
      discountCodeUsed = code.code;
      price = price * (1 - discountPercent / 100);
    }
  }

  if (price <= 0) {
    // 100% discount — activate immediately
    if (discountCodeUsed) db.useDiscountCode(discountCodeUsed);
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const sub = db.createSubscription(req.streamer.id, tier, null, expiresAt);
    db.createTransaction(req.streamer.id, null, 0, 'FREE_CODE', discountCodeUsed, discountPercent);
    console.log(`[Payment] Free subscription (${tier}) activated for ${req.streamer.discord_username} with code ${discountCodeUsed}`);
    return res.redirect('/dashboard/subscription?msg=activated');
  }

  // Store payment intent in session cookie
  res.cookie('payment_intent', JSON.stringify({ tier, price, discountPercent, discountCodeUsed }), {
    httpOnly: true, maxAge: 30 * 60 * 1000, // 30 minutes
  });

  // Create PayPal order
  createPayPalOrder(price, `Atleta ${tier.charAt(0).toUpperCase() + tier.slice(1)} - Annual Subscription`)
    .then((order) => {
      const approveLink = order.links?.find((l) => l.rel === 'approve');
      if (approveLink) {
        res.cookie('paypal_order_id', order.id, { httpOnly: true, maxAge: 30 * 60 * 1000 });
        res.redirect(approveLink.href);
      } else {
        console.error('[Payment] PayPal order creation failed:', JSON.stringify(order));
        res.redirect('/pricing?msg=payment_error');
      }
    })
    .catch((err) => {
      console.error(`[Payment] PayPal error: ${err.message}`);
      res.redirect('/pricing?msg=payment_error');
    });
});

// --- PayPal success redirect ---

router.get('/success', async (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');

  const orderId = req.cookies?.paypal_order_id;
  const intentStr = req.cookies?.payment_intent;

  if (!orderId || !intentStr) return res.redirect('/pricing?msg=payment_error');

  try {
    const intent = JSON.parse(intentStr);
    const capture = await capturePayPalOrder(orderId);

    if (capture.status === 'COMPLETED') {
      const paymentId = capture.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId;

      if (intent.discountCodeUsed) db.useDiscountCode(intent.discountCodeUsed);

      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
      db.createSubscription(req.streamer.id, intent.tier, paymentId, expiresAt);
      db.createTransaction(req.streamer.id, null, intent.price, paymentId, intent.discountCodeUsed, intent.discountPercent);

      console.log(`[Payment] ${intent.tier} subscription activated for ${req.streamer.discord_username} (${intent.price} EUR)`);

      res.clearCookie('paypal_order_id');
      res.clearCookie('payment_intent');
      res.redirect('/dashboard/subscription?msg=activated');
    } else {
      console.error('[Payment] Capture failed:', JSON.stringify(capture));
      res.redirect('/pricing?msg=payment_error');
    }
  } catch (err) {
    console.error(`[Payment] Success handler error: ${err.message}`);
    res.redirect('/pricing?msg=payment_error');
  }
});

// --- PayPal cancel ---

router.get('/cancel', (req, res) => {
  res.clearCookie('paypal_order_id');
  res.clearCookie('payment_intent');
  res.redirect('/pricing?msg=cancelled');
});

// --- Subscription management ---

router.get('/subscription', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');

  const subscription = db.getSubscription(req.streamer.id);
  const tierConfig = config.tiers[subscription?.tier || 'free'];

  res.render('subscription', {
    streamer: req.streamer,
    subscription,
    tierConfig,
    tiers: config.tiers,
    msg: req.query.msg,
  });
});

router.post('/subscription/cancel', (req, res) => {
  if (!req.streamer) return res.redirect('/auth/login');

  db.cancelSubscription(req.streamer.id);
  console.log(`[Payment] Subscription cancelled for ${req.streamer.discord_username}`);
  res.redirect('/dashboard/subscription?msg=cancelled');
});

module.exports = router;

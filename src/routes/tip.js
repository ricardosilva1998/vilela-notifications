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

async function capturePayPalOrder(orderId) {
  const token = await getPayPalToken();
  const res = await fetch(`${config.paypal.baseUrl}/v2/checkout/orders/${orderId}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.json();
}

// ─── Public tip page ──────────────────────────────────────────────────────────

router.get('/:username', (req, res) => {
  const streamer = db.getStreamerByUsername(req.params.username);
  if (!streamer || !streamer.donation_page_enabled || !streamer.paypal_email) {
    return res.status(404).send('Donation page not available.');
  }

  let avatarUrl = null;
  try {
    avatarUrl = streamer.twitch_profile_image || null;
  } catch (e) {}

  const success = req.query.success === '1';
  res.render('tip', { streamer, avatarUrl, success });
});

// ─── Create PayPal order for tip ─────────────────────────────────────────────

router.post('/:username/create', async (req, res) => {
  const streamer = db.getStreamerByUsername(req.params.username);
  if (!streamer || !streamer.donation_page_enabled || !streamer.paypal_email) {
    return res.status(404).send('Donation page not available.');
  }

  const amount = parseFloat(req.body.amount);
  const minAmount = streamer.donation_min_amount || 1;
  const currency = streamer.donation_currency || 'EUR';
  const message = (req.body.message || '').substring(0, 200);
  const donorName = (req.body.donor_name || 'Anonymous').substring(0, 50) || 'Anonymous';

  if (isNaN(amount) || amount < minAmount) {
    return res.status(400).send('Invalid amount.');
  }

  try {
    const token = await getPayPalToken();
    const orderRes = await fetch(`${config.paypal.baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: { currency_code: currency, value: amount.toFixed(2) },
          description: `Donation to ${streamer.twitch_display_name || streamer.twitch_username}`,
          payee: { email_address: streamer.paypal_email },
        }],
        application_context: {
          return_url: `${config.app.url}/tip/${streamer.twitch_username}/success?donor=${encodeURIComponent(donorName)}&message=${encodeURIComponent(message)}&amount=${amount}&currency=${currency}`,
          cancel_url: `${config.app.url}/tip/${streamer.twitch_username}`,
          brand_name: 'Atleta',
          user_action: 'PAY_NOW',
        },
      }),
    });
    const order = await orderRes.json();

    if (order.id) {
      const approveUrl = order.links?.find(l => l.rel === 'approve')?.href;
      if (approveUrl) return res.redirect(approveUrl);
    }
    console.error('[Tip] PayPal order creation failed:', order);
    res.status(500).send('Payment error. Please try again.');
  } catch (e) {
    console.error('[Tip] PayPal error:', e.message);
    res.status(500).send('Payment error. Please try again.');
  }
});

// ─── PayPal return after successful payment — capture and trigger overlay ─────

router.get('/:username/success', async (req, res) => {
  const streamer = db.getStreamerByUsername(req.params.username);
  if (!streamer) return res.status(404).send('Streamer not found.');

  const orderId = req.query.token; // PayPal passes order ID as 'token'
  const donorName = req.query.donor || 'Anonymous';
  const message = req.query.message || '';
  const amount = req.query.amount || '0';
  const currency = req.query.currency || 'EUR';

  if (orderId) {
    try {
      const capture = await capturePayPalOrder(orderId);
      if (capture.status === 'COMPLETED') {
        console.log(`[Tip] Donation captured: ${donorName} → ${streamer.twitch_username} (${currency} ${amount})`);

        // Fire overlay alert
        const bus = require('../services/overlayBus');
        bus.emit(`overlay:${streamer.id}`, {
          type: 'donation',
          data: {
            username: donorName,
            amount: parseFloat(amount),
            message: message,
            currency: currency,
          },
        });
        try { db.logOverlayEvent(streamer.id, 'donation', donorName, { amount: parseFloat(amount), currency }); } catch (e) {}

        // Fire chatbot message
        try {
          const { chatManager } = require('../services/twitchChat');
          chatManager.sendEventMessage(streamer.id, 'donation', {
            username: donorName,
            amount: `${currency} ${amount}`,
            message: message,
          });
        } catch (e) {}
      }
    } catch (e) {
      console.error('[Tip] Capture error:', e.message);
    }
  }

  res.redirect(`/tip/${streamer.twitch_username}?success=1`);
});

module.exports = router;

const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const db = require('./db');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payment');

const app = express();

// Middleware
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// EJS setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session middleware — attach streamer to request if logged in
app.use((req, res, next) => {
  const sid = req.cookies?.session;
  if (sid) {
    const session = db.getSession(sid);
    if (session) {
      req.streamer = db.getStreamerById(session.streamer_id);
    }
  }
  next();
});

// Routes
app.get('/', (req, res) => {
  if (req.streamer) return res.redirect('/dashboard');
  res.render('login', { streamer: null });
});

app.get('/tutorial', (req, res) => {
  res.render('tutorial', { streamer: req.streamer || null });
});

app.get('/pricing', (req, res) => {
  res.render('pricing', {
    streamer: req.streamer || null,
    tiers: config.tiers,
    currentTier: req.streamer ? db.getStreamerTier(req.streamer.id) : null,
    msg: req.query.msg,
  });
});

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/payment', paymentRoutes);
app.use('/api', apiRoutes);
app.use('/admin', adminRoutes);

// Health check
app.get('/health', (req, res) => res.send('OK'));

function start() {
  const port = config.app.port;
  app.listen(port, () => {
    console.log(`[Server] Dashboard at ${config.app.url}`);
  });

  // Ensure all streamers have a subscription record
  db.ensureFreeSubscriptions();

  // Clean expired sessions every hour
  setInterval(() => db.cleanExpiredSessions(), 60 * 60 * 1000);

  // Check for expired subscriptions every hour
  setInterval(() => db.expireSubscriptions(), 60 * 60 * 1000);
}

module.exports = { start };

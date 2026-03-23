const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const config = require('./config');
const db = require('./db');

const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const apiRoutes = require('./routes/api');

const app = express();

// Middleware
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

app.use('/auth', authRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/api', apiRoutes);

// Health check
app.get('/health', (req, res) => res.send('OK'));

function start() {
  const port = config.app.port;
  app.listen(port, () => {
    console.log(`[Server] Dashboard at ${config.app.url}`);
  });

  // Clean expired sessions every hour
  setInterval(() => db.cleanExpiredSessions(), 60 * 60 * 1000);
}

module.exports = { start };

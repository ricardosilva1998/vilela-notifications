const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  if (req.racingUser) return res.redirect('/racing/dashboard');
  res.render('racing-landing', { streamer: req.streamer || null, racingUser: null, error: req.query.error || null });
});

router.get('/signup', (req, res) => {
  res.render('racing-signup', { streamer: req.streamer || null, racingUser: null, error: req.query.error || null });
});

router.use((req, res, next) => {
  if (!req.racingUser) return res.redirect('/racing');
  next();
});

router.get('/dashboard', (req, res) => {
  res.render('racing-dashboard', { streamer: req.streamer || null, racingUser: req.racingUser });
});

router.get('/account', (req, res) => {
  res.render('racing-account', { streamer: req.streamer || null, racingUser: req.racingUser, msg: req.query.msg || null, error: req.query.error || null });
});

module.exports = router;

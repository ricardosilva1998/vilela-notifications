const { Router } = require('express');
const { client } = require('../discord');
const db = require('../db');

const router = Router();

router.use((req, res, next) => {
  if (!req.streamer) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// Streamer must have claimed the guild before they can read its channel/role list.
function requireGuildOwnership(req, res, next) {
  if (!/^\d{5,30}$/.test(req.params.guildId || '')) return res.status(400).json({ error: 'Bad guildId' });
  if (!db.getGuildConfig(req.params.guildId, req.streamer.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

router.get('/guild/:guildId/channels', requireGuildOwnership, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);

  const channels = guild.channels.cache
    .filter((c) => c.type === 0)
    .map((c) => ({ id: c.id, name: c.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json(channels);
});

router.get('/guild/:guildId/roles', requireGuildOwnership, (req, res) => {
  const guild = client.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);

  const roles = guild.roles.cache
    .filter((r) => !r.managed && r.name !== '@everyone')
    .map((r) => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json(roles);
});

module.exports = router;

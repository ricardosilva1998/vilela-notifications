const fs = require('fs');
const path = require('path');

const AUTH_PATH = path.join(__dirname, '..', 'data', 'auth.json');
const LINKS_PATH = path.join(__dirname, '..', 'data', 'links.json');

const DEFAULT_AUTH = {
  broadcasterAccessToken: null,
  broadcasterRefreshToken: null,
  broadcasterTokenExpiresAt: 0,
};

function ensureDir() {
  const dir = path.dirname(AUTH_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadAuth() {
  try {
    return { ...DEFAULT_AUTH, ...JSON.parse(fs.readFileSync(AUTH_PATH, 'utf-8')) };
  } catch {
    return { ...DEFAULT_AUTH };
  }
}

function saveAuth(auth) {
  ensureDir();
  const tmp = AUTH_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2));
  fs.renameSync(tmp, AUTH_PATH);
}

// Links: { discordUserId: { twitchUserId, twitchUsername } }
function loadLinks() {
  try {
    return JSON.parse(fs.readFileSync(LINKS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveLinks(links) {
  ensureDir();
  const tmp = LINKS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(links, null, 2));
  fs.renameSync(tmp, LINKS_PATH);
}

function linkUser(discordUserId, twitchUserId, twitchUsername) {
  const links = loadLinks();
  links[discordUserId] = { twitchUserId, twitchUsername };
  saveLinks(links);
}

function getLinkedUsers() {
  return loadLinks();
}

module.exports = { loadAuth, saveAuth, linkUser, getLinkedUsers };

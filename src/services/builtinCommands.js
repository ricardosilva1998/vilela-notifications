'use strict';

const cooldowns = new Map();
const COOLDOWN_MS = 5000;

function onCooldown(streamerId, cmd) {
  const key = `${streamerId}:${cmd}`;
  const now = Date.now();
  if (now - (cooldowns.get(key) || 0) < COOLDOWN_MS) return true;
  cooldowns.set(key, now);
  return false;
}

// ─── 8-Ball responses ─────────────────────────────────────────────────────────
const EIGHT_BALL = [
  'It is certain', 'Without a doubt', 'Yes, definitely', 'You may rely on it',
  'Most likely', 'Outlook good', 'Yes', 'Signs point to yes',
  'Reply hazy, try again', 'Ask again later', 'Better not tell you now',
  'Cannot predict now', 'Concentrate and ask again', 'Don\'t count on it',
  'My reply is no', 'My sources say no', 'Outlook not so good',
  'Very doubtful', 'Absolutely not', 'In your dreams',
];

// ─── Slap objects ─────────────────────────────────────────────────────────────
const SLAP_OBJECTS = [
  'a wet fish 🐟', 'a rubber chicken 🐔', 'a keyboard ⌨️', 'a large trout 🐠',
  'a pillow 🛏️', 'a banana peel 🍌', 'a pool noodle 🏊', 'a baguette 🥖',
  'a foam sword ⚔️', 'a rolled-up newspaper 📰', 'a slice of pizza 🍕',
  'a rubber duck 🦆', 'a steering wheel 🏎️', 'a racing flag 🏁',
];

// ─── Roast lines ──────────────────────────────────────────────────────────────
const ROASTS = [
  "you drive like my grandma... and she doesn't have a license 🏎️",
  "your pit crew called — they quit 🔧",
  "you're so slow, the safety car laps YOU 🐢",
  "I've seen faster loading screens than your lap times 💤",
  "your racing line looks like a drunk GPS route 🗺️",
  "you bring a whole new meaning to 'taking it easy' 😴",
  "even the pace car is embarrassed for you 🏎️💨",
  "your tire strategy? All four... flat 💀",
  "you corner like a shopping cart with a bad wheel 🛒",
  "the only thing you're overtaking is the scenery 🌲",
  "your DRS stands for 'Desperately Really Slow' 📡",
  "you've got great car control... for a bumper car 🎪",
  "your telemetry data made the engineers cry 📊😭",
  "the marshal showed you a blue flag... out of sympathy 🟦",
  "Legend says you're still looking for the apex 🔍",
];

// ─── Racing quotes ────────────────────────────────────────────────────────────
const QUOTES = [
  '"If you\'re not first, you\'re last." — Ricky Bobby 🏆',
  '"Rubbin\' is racin\'." — Days of Thunder 🏎️',
  '"To finish first, you must first finish." — Juan Manuel Fangio 🏁',
  '"Speed has never killed anyone. It\'s suddenly becoming stationary that gets you." — Jeremy Clarkson 💥',
  '"If everything seems under control, you\'re not going fast enough." — Mario Andretti ⚡',
  '"Racing is the best way to convert money into noise." — Unknown 💸',
  '"You can\'t overtake 15 cars when it\'s sunny, but you can when it\'s raining." — Ayrton Senna 🌧️',
  '"The crashes people remember, but drivers remember the near misses." — Mario Andretti 😰',
  '"I am not designed to come second or third. I am designed to win." — Ayrton Senna 🥇',
  '"Auto racing began 5 minutes after the second car was built." — Henry Ford 🚗',
  '"There\'s a lot of money in racing. The problem is keeping it." — Unknown 💰',
  '"Aerodynamics are for people who can\'t build engines." — Enzo Ferrari 🔥',
  '"Straight roads are for fast cars, turns are for fast drivers." — Colin McRae 🏔️',
  '"The winner ain\'t the one with the fastest car. It\'s the one who refuses to lose." — Dale Earnhardt 💪',
  '"Life is too short to drive boring cars." — Unknown 🏎️',
];

// ─── Helper: format duration ──────────────────────────────────────────────────
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  const parts = [];
  if (years > 0) parts.push(`${years} year${years !== 1 ? 's' : ''}`);
  if (months % 12 > 0) parts.push(`${months % 12} month${months % 12 !== 1 ? 's' : ''}`);
  if (days % 30 > 0 && years === 0) parts.push(`${days % 30} day${days % 30 !== 1 ? 's' : ''}`);
  if (parts.length === 0 && hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
  if (parts.length === 0 && minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
  if (parts.length === 0) parts.push('less than a minute');
  return parts.join(', ');
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60) % 60;
  const h = Math.floor(s / 3600);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ─── Main handler ─────────────────────────────────────────────────────────────
async function handleBuiltinCommand(client, channel, tags, commandName, args, streamer) {
  const name = tags['display-name'] || tags.username;
  const sid = streamer.id;

  switch (commandName) {
    case 'followage': {
      if (!streamer.cmd_followage_enabled) return false;
      if (onCooldown(sid, 'followage')) return true;
      try {
        const { getFollowAge } = require('./twitch');
        const result = await getFollowAge(channel.replace(/^#/, ''), tags.username);
        if (result.following && result.followedAt) {
          const dur = formatDuration(Date.now() - new Date(result.followedAt).getTime());
          client.say(channel, `🏁 ${name} has been following for ${dur}!`).catch(() => {});
        } else {
          client.say(channel, `${name} is not following the channel.`).catch(() => {});
        }
      } catch (e) {
        client.say(channel, `Could not check follow age.`).catch(() => {});
      }
      return true;
    }

    case 'subage': {
      if (!streamer.cmd_subage_enabled) return false;
      if (onCooldown(sid, 'subage')) return true;
      if (tags.subscriber) {
        const badges = tags.badges || {};
        const months = tags['badge-info']?.subscriber || '0';
        client.say(channel, `🏆 ${name} has been subscribed for ${months} month${months !== '1' ? 's' : ''}!`).catch(() => {});
      } else {
        client.say(channel, `${name} is not subscribed.`).catch(() => {});
      }
      return true;
    }

    case 'uptime': {
      if (!streamer.cmd_uptime_enabled) return false;
      if (onCooldown(sid, 'uptime')) return true;
      try {
        const { getStream } = require('./twitch');
        const stream = await getStream(channel.replace(/^#/, ''));
        if (stream && stream.started_at) {
          const dur = formatUptime(Date.now() - new Date(stream.started_at).getTime());
          client.say(channel, `🔴 Stream has been live for ${dur}`).catch(() => {});
        } else {
          client.say(channel, `Stream is currently offline.`).catch(() => {});
        }
      } catch (e) {
        client.say(channel, `Could not check stream status.`).catch(() => {});
      }
      return true;
    }

    case 'accountage': {
      if (!streamer.cmd_accountage_enabled) return false;
      if (onCooldown(sid, 'accountage')) return true;
      try {
        const { getUserInfo } = require('./twitch');
        const user = await getUserInfo(tags.username);
        if (user && user.created_at) {
          const dur = formatDuration(Date.now() - new Date(user.created_at).getTime());
          client.say(channel, `📅 ${name}'s Twitch account was created ${dur} ago!`).catch(() => {});
        } else {
          client.say(channel, `Could not check account age.`).catch(() => {});
        }
      } catch (e) {
        client.say(channel, `Could not check account age.`).catch(() => {});
      }
      return true;
    }

    case '8ball': {
      if (!streamer.cmd_8ball_enabled) return false;
      if (onCooldown(sid, '8ball')) return true;
      const question = args.join(' ');
      const answer = pick(EIGHT_BALL);
      client.say(channel, question
        ? `🎱 ${name} asks: "${question}" → ${answer}`
        : `🎱 ${answer}`
      ).catch(() => {});
      return true;
    }

    case 'roll': {
      if (!streamer.cmd_roll_enabled) return false;
      if (onCooldown(sid, 'roll')) return true;
      const max = parseInt(args[0]) || 20;
      const result = Math.floor(Math.random() * max) + 1;
      client.say(channel, `🎲 ${name} rolled a ${result}! (1-${max})`).catch(() => {});
      return true;
    }

    case 'hug': {
      if (!streamer.cmd_hug_enabled) return false;
      if (onCooldown(sid, 'hug')) return true;
      const target = args[0]?.replace('@', '') || 'themselves';
      client.say(channel, `🤗 ${name} gives ${target} a big warm hug!`).catch(() => {});
      return true;
    }

    case 'slap': {
      if (!streamer.cmd_slap_enabled) return false;
      if (onCooldown(sid, 'slap')) return true;
      const slapTarget = args[0]?.replace('@', '') || 'the air';
      const object = pick(SLAP_OBJECTS);
      client.say(channel, `${name} slaps ${slapTarget} with ${object}!`).catch(() => {});
      return true;
    }

    case 'love': {
      if (!streamer.cmd_love_enabled) return false;
      if (onCooldown(sid, 'love')) return true;
      const loveTarget = args[0]?.replace('@', '');
      if (!loveTarget) {
        client.say(channel, `Usage: !love @username`).catch(() => {});
      } else {
        const percent = Math.floor(Math.random() * 101);
        const hearts = percent > 75 ? '💕💕💕' : percent > 50 ? '💕💕' : percent > 25 ? '💕' : '💔';
        client.say(channel, `${hearts} There is ${percent}% love between ${name} and ${loveTarget}!`).catch(() => {});
      }
      return true;
    }

    case 'rps': {
      if (!streamer.cmd_rps_enabled) return false;
      if (onCooldown(sid, 'rps')) return true;
      const choices = ['rock', 'paper', 'scissors'];
      const emojis = { rock: '🪨', paper: '📄', scissors: '✂️' };
      const userChoice = (args[0] || '').toLowerCase();
      if (!choices.includes(userChoice)) {
        client.say(channel, `Usage: !rps rock/paper/scissors`).catch(() => {});
        return true;
      }
      const botChoice = pick(choices);
      let result;
      if (userChoice === botChoice) result = "It's a tie!";
      else if (
        (userChoice === 'rock' && botChoice === 'scissors') ||
        (userChoice === 'paper' && botChoice === 'rock') ||
        (userChoice === 'scissors' && botChoice === 'paper')
      ) result = `${name} wins! 🎉`;
      else result = `Bot wins! 😎`;
      client.say(channel, `${name}: ${emojis[userChoice]} vs Bot: ${emojis[botChoice]} — ${result}`).catch(() => {});
      return true;
    }

    case 'coinflip':
    case 'flip': {
      if (!streamer.cmd_coinflip_enabled) return false;
      if (onCooldown(sid, 'coinflip')) return true;
      const side = Math.random() < 0.5 ? 'Heads' : 'Tails';
      client.say(channel, `🪙 ${name} flipped a coin: ${side}!`).catch(() => {});
      return true;
    }

    case 'quote': {
      if (!streamer.cmd_quote_enabled) return false;
      if (onCooldown(sid, 'quote')) return true;
      client.say(channel, pick(QUOTES)).catch(() => {});
      return true;
    }

    case 'roast': {
      if (!streamer.cmd_roast_enabled) return false;
      if (onCooldown(sid, 'roast')) return true;
      const roastTarget = args[0]?.replace('@', '') || name;
      client.say(channel, `${roastTarget}, ${pick(ROASTS)}`).catch(() => {});
      return true;
    }

    default:
      return false;
  }
}

module.exports = { handleBuiltinCommand };

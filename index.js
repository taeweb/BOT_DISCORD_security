import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);
const express = require('express')
const app = express()
const port = process.env.PORT || 4000

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})
// Log Redis events
redis.on('connect', () => console.log('[Redis] Connected successfully'));
redis.on('error', (err) => console.error('[Redis] Redis error:', err));

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel]
});

// Message history for duplicate/flood detection
const msgHistory = new Map();
const inviteRegex = /(discord\.gg|discord\.com\/invite)/i;
const BAD_WORDS = ['badword1','badword2']; // เพิ่มคำหยาบ

// Helper functions
function containsBadWord(text) {
  return BAD_WORDS.some(w => text.toLowerCase().includes(w));
}

async function isRateLimited(userId) {
  const key = `rl:${userId}`;
  const cur = await redis.incr(key);
  if (cur === 1) await redis.expire(key, 5); // 5s window
  return cur > 2; // max 2 messages / 5s
}

async function takeAction(guildId, memberId, action, reason) {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(memberId).catch(()=>null);
  if (!member) return;
  if (action === 'mute') {
    let role = guild.roles.cache.find(r => r.name === 'Muted');
    if (!role) role = await guild.roles.create({ name: 'Muted', permissions: [] });
    await member.roles.add(role, reason);
  }
}

// Bot ready log
client.once('ready', () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  console.log(`[Bot] Watching ${client.guilds.cache.size} guild(s)`);
});

// Message handler
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const { content, author, guildId, channel, mentions } = message;
  const userId = author.id;
  const text = content.trim();

  console.log(`[Message] ${author.tag} in ${message.guild?.name || 'DM'}: ${text}`);

  // 1) Rate limit
  if (await isRateLimited(userId)) {
    await message.delete().catch(()=>{});
    console.log(`[Blocked] Rate limit ${author.tag}`);
    return;
  }

  // 2) Bad words
  if (containsBadWord(text)) {
    await message.delete().catch(()=>{});
    console.log(`[Blocked] Bad word ${author.tag}`);
    return;
  }

  // 3) Invite links
  if (inviteRegex.test(text)) {
    await message.delete().catch(()=>{});
    console.log(`[Blocked] Invite link ${author.tag}`);
    return;
  }

  // 4) Duplicate message
  const now = Date.now();
  const last = msgHistory.get(userId);
  if (!last) {
    msgHistory.set(userId, { lastMsg: text, lastTime: now, count: 1 });
  } else {
    if (last.lastMsg === text) last.count++;
    else { last.lastMsg = text; last.count = 1; }
    last.lastTime = now;
    msgHistory.set(userId, last);
    if (last.count >= 3) {
      await message.delete().catch(()=>{});
      console.log(`[Blocked] Duplicate ${author.tag}`);
      return;
    }
  }

  // 5) Flood detection (over 6 messages in short time)
  const floodKey = `flood:${userId}`;
  const floodCount = await redis.incr(floodKey);
  if (floodCount === 1) await redis.expire(floodKey, 3);
  if (floodCount > 6) {
    await message.delete().catch(()=>{});
    console.log(`[Blocked] Flood ${author.tag}`);
    return;
  }

  // 6) Too many mentions
  if (mentions.users.size > 5) {
    await message.delete().catch(()=>{});
    console.log(`[Blocked] Too many mentions ${author.tag}`);
    return;
  }

  // 7) Too many links
  if (/https?:\/\//.test(text) && text.split("http").length > 3) {
    await message.delete().catch(()=>{});
    console.log(`[Blocked] Too many links ${author.tag}`);
    return;
  }
});

// Login
client.login(process.env.DISCORD_TOKEN_1)
  .then(()=>console.log('[Bot] Login successful'))
  .catch(err=>console.error('[Bot] Login failed:', err));

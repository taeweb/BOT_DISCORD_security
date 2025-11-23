import 'dotenv/config';
import { 
  Client, 
  GatewayIntentBits, 
  Partials,
  AuditLogEvent 
} from 'discord.js';
import Redis from 'ioredis';
import express from 'express';

const redis = new Redis(process.env.REDIS_URL);

const STAFF_LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL;
const BOT_WHITELIST = process.env.BOT_WHITELIST
  ? process.env.BOT_WHITELIST.split(",").map(v => v.trim())
  : [];
BOT_WHITELIST.push(client.user.id); // เพิ่ม bot ตัวเอง

let raidMode = false;

// -------------------------------
// Web server
// -------------------------------
const app = express();
const port = process.env.PORT || 4000;

app.get('/', (req, res) => res.send('Hello World!'));
app.listen(port, () => console.log(`[Web] Running on port ${port}`));

// -------------------------------
// Discord Client
// -------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel]
});

// -------------------------------
// Tools
// -------------------------------
function sendLog(guild, title, description, color = 0xff0000) {
  const ch = guild.channels.cache.get(STAFF_LOG_CHANNEL_ID);
  if (!ch) return;
  ch.send({
    embeds: [{
      title,
      description,
      color,
      timestamp: new Date()
    }]
  }).catch(()=>{});
}

async function lockGuild(guild) {
  if (raidMode) return;
  raidMode = true;

  sendLog(guild, "🔒 RAID MODE ENABLED", "Server locked due to RAID attack");

  guild.channels.cache.forEach(async ch => {
    await ch.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: false
    }).catch(()=>{});
  });

  console.log("[RAID] Guild locked");
}

async function unlockGuild(guild) {
  if (!raidMode) return;
  raidMode = false;

  sendLog(guild, "🔓 RAID MODE DISABLED", "Server unlocked");

  guild.channels.cache.forEach(async ch => {
    await ch.permissionOverwrites.edit(guild.roles.everyone, {
      SendMessages: null
    }).catch(()=>{});
  });

  console.log("[RAID] Guild unlocked");
}

// -------------------------------
// Helper Functions
// -------------------------------
function containsBadWord(text) {
  const BAD_WORDS = ['badword1', 'badword2'];
  return BAD_WORDS.some(w => text.toLowerCase().includes(w));
}

async function isRateLimited(userId) {
  const key = `rl:${userId}`;
  const cur = await redis.incr(key);
  if (cur === 1) await redis.expire(key, 5);
  return cur > 2;
}

async function isSpamming(userId) {
  const key = `spam:${userId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 3);
  return n > 2;
}

async function isHardLimit(userId, text) {
  const words = text.split(/\s+/);
  if (words.length <= 2) return false;

  const key = `hard:${userId}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 3);
  return true;
}

async function muteUser(guildId, memberId, seconds, reason) {
  const guild = await client.guilds.fetch(guildId);
  const member = await guild.members.fetch(memberId).catch(()=>null);
  if (!member) return;

  let muteRole = guild.roles.cache.find(r => r.name === "Muted");
  if (!muteRole) {
    muteRole = await guild.roles.create({
      name: "Muted",
      permissions: []
    }).catch(()=>{});
  }

  await member.roles.add(muteRole, reason).catch(()=>{});
  setTimeout(() => {
    member.roles.remove(muteRole, "Mute expired").catch(()=>{});
  }, seconds * 1000);
}

// -------------------------------
// Anti-Nuke (ตรวจทุกคน, ไม่เช็ค ownerId)
// -------------------------------
const ANTI_NUKE_LIMIT = 2; // ครั้งที่อนุญาตก่อน BAN

client.on("guildAuditLogEntryCreate", async (entry) => {
  const guild = entry.guild;
  const exe = entry.executor;
  if (!exe || !guild) return; // เช็คก่อนใช้งาน

  const forbidden = [
    AuditLogEvent.ChannelDelete,
    AuditLogEvent.RoleDelete,
    AuditLogEvent.MemberKick,
    AuditLogEvent.MemberBanAdd
  ];

  if (!forbidden.includes(entry.action)) return;

  const key = `anti_nuke:${guild.id}:${exe.id}`;
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, 3600); // reset 1 ชั่วโมง

  if (n > ANTI_NUKE_LIMIT) {
    // BAN user
    await guild.members.ban(exe.id, { reason: "Anti-Nuke limit exceeded" }).catch(()=>{});
    sendLog(guild, "🚨 ANTI-NUKE BAN", `${exe.tag} ทำผิดเกินจำนวนครั้งที่อนุญาต`);
  } else {
    sendLog(guild, "⚠ ANTI-NUKE Warning", `${exe.tag} ทำผิด Anti-Nuke ครั้งที่ ${n}`);
  }
});

// -------------------------------
// On Bot Ready
// -------------------------------
client.on("clientReady", () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
});

// -------------------------------
// Message Handler
// -------------------------------
const msgHistory = new Map();
const inviteRegex = /(discord\.gg|discord\.com\/invite)/i;

client.on("messageCreate", async message => {
  const guild = message.guild;
  if (!guild) return;

  const { content, author } = message;
  const userId = author.id;
  const text = content.trim();
  const mentions = message.mentions;

  // RAID BURST
  const key = `burst:${guild.id}`;
  const burst = await redis.incr(key);
  if (burst === 1) await redis.expire(key, 3);

  if (burst > 20) {
    sendLog(guild, "⚠ RAID DETECTED", "Mass message burst detected");
    await lockGuild(guild);
    setTimeout(() => unlockGuild(guild), 30000);
  }

  // BLOCK EXTERNAL BOTS
  if (author.bot && !BOT_WHITELIST.includes(author.id)) {
    await message.delete().catch(()=>{});
    sendLog(guild, "🤖 External Bot Blocked", `${author.tag}`);
    return;
  }

  // HARD LIMIT: 2 WORDS / 3 SEC
  if (await isHardLimit(userId, text)) {
    await message.delete().catch(()=>{});
    sendLog(guild, "⌛ Hard Limit Triggered", `${author.tag} sent more than 2 words`);
    return;
  }

  // SPAM
  if (await isSpamming(userId)) {
    await message.delete().catch(()=>{});
    await muteUser(guild.id, userId, 120, "Spam");
    sendLog(guild, "⛔ Spam Blocked", `${author.tag}`);
    return;
  }

  // RATE LIMIT
  if (await isRateLimited(userId)) {
    await message.delete().catch(()=>{});
    sendLog(guild, "📥 Rate Limit", `${author.tag}`);
    return;
  }

  // BAD WORDS
  if (containsBadWord(text)) {
    await message.delete().catch(()=>{});
    sendLog(guild, "🤬 Bad Word", `${author.tag}`);
    return;
  }

  // INVITE LINKS
  if (inviteRegex.test(text)) {
    await message.delete().catch(()=>{});
    sendLog(guild, "🚫 Invite Blocked", `${author.tag}`);
    return;
  }

  // DUPLICATE
  const now = Date.now();
  const last = msgHistory.get(userId);

  if (!last) {
    msgHistory.set(userId, { lastMsg: text, count: 1 });
  } else {
    if (last.lastMsg === text) last.count++;
    else { last.lastMsg = text; last.count = 1; }

    if (last.count >= 3) {
      await message.delete().catch(()=>{});
      sendLog(guild, "📛 Duplicate", `${author.tag}`);
      return;
    }
  }

  // FLOOD (> 6 MESSAGES / 3s)
  const floodKey = `flood:${userId}`;
  const flood = await redis.incr(floodKey);
  if (flood === 1) await redis.expire(floodKey, 5);
  if (flood > 3) {
    await message.delete().catch(()=>{});
    sendLog(guild, "🌊 Flood", `${author.tag}`);
    return;
  }

  // MENTION SPAM
  if (mentions.users.size > 5 || mentions.roles.size > 5) {
    await message.delete().catch(()=>{});
    sendLog(guild, "🔔 Mention Spam", `${author.tag}`);
    return;
  }

  // LINK SPAM
  if (/https?:\/\//.test(text) && text.split("http").length > 3) {
    await message.delete().catch(()=>{});
    sendLog(guild, "🔗 Link Spam", `${author.tag}`);
    return;
  }
});

// --------------------------------------
// Login
// --------------------------------------
client.login(process.env.DISCORD_TOKEN_1);

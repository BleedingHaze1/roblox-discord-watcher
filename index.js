// index.js
// Discord bot hosted on Render (or any Node host).
// Live panel + join/leave alerts + slash commands.
// Node 18+, discord.js v14.

// ===== EASY CONFIG (edit these) ===========================================
const CONFIG = {
  GROUP_ID: 872876,               // Imperialist Robloxian Federation
  MIN_RANK: 143,                  // "High Command" and above
  TARGET_PLACE_ID: "583507031",   // PAPERS PLEASE UPDATE
  POLL_INTERVAL_MS: 10000,        // 10s poll
  MEMBERS_REFRESH_MINUTES: 15,    // refresh roster every 15 min
  ALERTS_ENABLED: true,           // ON by default (set false to silence join/leave)
  PANEL_TITLE: "Imperialist Robloxian Federation — Live Panel",
  TIMEZONE: "UTC",                // Just text for footer
};
// ==========================================================================

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits
} = require("discord.js");

// ---- Storage (panel persistence) ----
// Note: Render workers have ephemeral disks. Losing this file only means
// the panel message ID may be forgotten on restart; the bot will just make a new panel.
const STORE_PATH = path.join(__dirname, "storage.json");
let STORE = { panel: { channelId: null, messageId: null } };
try { if (fs.existsSync(STORE_PATH)) STORE = JSON.parse(fs.readFileSync(STORE_PATH, "utf8")); } catch {}
function saveStore() { try { fs.writeFileSync(STORE_PATH, JSON.stringify(STORE, null, 2)); } catch {} }

// ---- Roblox API endpoints ----
const GROUP_USERS_URL = (id, cursor = "") =>
  `https://groups.roblox.com/v1/groups/${id}/users?limit=100${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;
const PRESENCE_URL = "https://presence.roblox.com/v1/presence/users";
const USER_INFO_URL = (id) => `https://users.roblox.com/v1/users/${id}`;

// ---- State ----
let watchedUserIds = [];          // strings of userId
const lastPresence = new Map();   // userId -> { userPresenceType, placeId }
const usernameCache = new Map();  // userId -> displayName
let currentlyInGame = new Set();  // userIds currently in target place
let pollTimer = null;
let membersTimer = null;
let initialSweepDone = false;
let notifyChannelId = null;       // where alerts/panel live

// ---- Discord client ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const TOKEN = process.env.DISCORD_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_TOKEN env var. Add it on Render → Environment.");
  process.exit(1);
}

// ---- Utils ----
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchUsername(userId) {
  if (usernameCache.has(userId)) return usernameCache.get(userId);
  try {
    const r = await fetch(USER_INFO_URL(userId));
    if (r.ok) {
      const j = await r.json();
      const name = j.displayName || j.name || String(userId);
      usernameCache.set(userId, name);
      return name;
    }
  } catch {}
  return String(userId);
}

async function refreshGroupMembers() {
  const found = new Set();
  let cursor = "";
  while (true) {
    let res;
    try {
      res = await fetch(GROUP_USERS_URL(CONFIG.GROUP_ID, cursor));
    } catch (e) {
      console.warn("Group fetch network error:", e?.message || e);
      break;
    }
    if (!res.ok) {
      console.warn("Group fetch failed:", res.status, await res.text().catch(()=>"..."));
      break;
    }
    const j = await res.json();
    for (const row of j.data || []) {
      const rank = row.role?.rank ?? 0;
      const uid = String(row.user?.userId ?? row.user?.id ?? "");
      if (uid && rank >= CONFIG.MIN_RANK) found.add(uid);
    }
    if (!j.nextPageCursor) break;
    cursor = j.nextPageCursor;
  }
  watchedUserIds = [...found];
  console.log(`✓ Watching ${watchedUserIds.length} users (rank ≥ ${CONFIG.MIN_RANK}).`);
  return watchedUserIds.length;
}

function chunk(arr, n) {
  const out = [];
  for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n));
  return out;
}

function formatList(names, max = 25) {
  if (names.length === 0) return "_none_";
  if (names.length <= max) return names.join(", ");
  return names.slice(0, max).join(", ") + `, +${names.length - max} more`;
}

function nowStamp() {
  return new Date().toISOString().replace("T"," ").replace("Z"," UTC");
}

// ---- Live panel helpers ----
async function ensurePanel(channel) {
  const embed = new EmbedBuilder()
    .setTitle(CONFIG.PANEL_TITLE)
    .setDescription(`Watching **rank ≥ ${CONFIG.MIN_RANK}** in group **${CONFIG.GROUP_ID}**\nTarget place: **${CONFIG.TARGET_PLACE_ID}**`)
    .addFields({ name: `Currently in game (0)`, value: "_none_" })
    .setFooter({ text: `Last update: waiting…` });

  // Reuse old panel if we have it
  if (STORE.panel.channelId && STORE.panel.messageId) {
    try {
      const ch = await client.channels.fetch(STORE.panel.channelId);
      const msg = await ch.messages.fetch(STORE.panel.messageId);
      await msg.edit({ embeds: [embed] });
      notifyChannelId = STORE.panel.channelId;
      return msg;
    } catch { /* make a new one */ }
  }

  // Create new panel
  const msg = await channel.send({ embeds: [embed] });
  STORE.panel.channelId = channel.id;
  STORE.panel.messageId = msg.id;
  notifyChannelId = channel.id;
  saveStore();
  return msg;
}

async function updatePanelMessage() {
  if (!STORE.panel.channelId || !STORE.panel.messageId) return;
  try {
    const ch = await client.channels.fetch(STORE.panel.channelId);
    const msg = await ch.messages.fetch(STORE.panel.messageId);

    const ids = [...currentlyInGame];
    const batches = chunk(ids, 50);
    const names = [];
    for (const b of batches) {
      const resolved = await Promise.all(b.map(id => fetchUsername(id)));
      names.push(...resolved);
    }

    const embed = new EmbedBuilder()
      .setTitle(CONFIG.PANEL_TITLE)
      .setDescription(`Watching **rank ≥ ${CONFIG.MIN_RANK}** in group **${CONFIG.GROUP_ID}**\nTarget place: **${CONFIG.TARGET_PLACE_ID}**`)
      .addFields({ name: `Currently in game (${ids.length})`, value: formatList(names) })
      .setFooter({ text: `Last update: ${nowStamp()}` });

    await msg.edit({ embeds: [embed] });
  } catch (e) {
    console.warn("Panel update failed:", e?.message || e);
  }
}

async function sendAlert(text) {
  if (!CONFIG.ALERTS_ENABLED) return;
  try {
    if (!notifyChannelId) return;
    const ch = await client.channels.fetch(notifyChannelId);
    if (ch && ch.isTextBased()) await ch.send({ content: text });
  } catch {}
}

// ---- Presence poll ----
async function pollPresenceOnce() {
  if (!watchedUserIds.length) return;
  let resp;
  try {
    resp = await fetch(PRESENCE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds: watchedUserIds.map(Number) }),
    });
  } catch (e) {
    console.warn("Presence network error:", e?.message || e);
    return;
  }
  if (resp.status === 429) {
    console.warn("429 (rate limited) — backing off one cycle");
    await sleep(CONFIG.POLL_INTERVAL_MS * 2);
    return;
  }
  if (!resp.ok) {
    console.warn("Presence error:", resp.status, await resp.text().catch(()=>"..."));
    return;
  }

  const data = await resp.json();
  const nextInGame = new Set();

  for (const p of data.userPresences || []) {
    const userId = String(p.userId);
    const now = { userPresenceType: p.userPresenceType, placeId: p.placeId ? String(p.placeId) : null };
    const prev = lastPresence.get(userId) || { userPresenceType: 0, placeId: null };

    const inTarget = now.placeId === CONFIG.TARGET_PLACE_ID;
    if (inTarget) nextInGame.add(userId);

    const joined = !currentlyInGame.has(userId) && inTarget;
    const left   =  currentlyInGame.has(userId) && !inTarget;

    if (!initialSweepDone && inTarget) {
      const name = await fetchUsername(userId);
      await sendAlert(`🟢 **${name}** is **already in the target game** (startup)`);
    } else {
      if (joined) {
        const name = await fetchUsername(userId);
        await sendAlert(`🟢 **${name}** **joined** the target game`);
      }
      if (left) {
        const name = await fetchUsername(userId);
        await sendAlert(`🔴 **${name}** **left** the target game`);
      }
    }

    lastPresence.set(userId, now);
  }

  currentlyInGame = nextInGame;
  initialSweepDone = true;
  await updatePanelMessage();
}

// ---- Start/Stop ----
async function startWatcher(channel) {
  const panelMsg = await ensurePanel(channel);
  notifyChannelId = panelMsg.channel.id;

  await sendAlert(`🔄 **Booting watcher…** group **${CONFIG.GROUP_ID}**, rank ≥ **${CONFIG.MIN_RANK}**, place **${CONFIG.TARGET_PLACE_ID}**`);

  const count = await refreshGroupMembers();
  await sendAlert(`✅ **Watcher started** — watching **${count}** users`);

  if (pollTimer) clearInterval(pollTimer);
  if (membersTimer) clearInterval(membersTimer);

  initialSweepDone = false;
  await pollPresenceOnce();
  pollTimer = setInterval(() => { pollPresenceOnce(); }, CONFIG.POLL_INTERVAL_MS);
  membersTimer = setInterval(async () => {
    const newCount = await refreshGroupMembers();
    await sendAlert(`↻ Roster refreshed — now watching **${newCount}** users`);
  }, CONFIG.MEMBERS_REFRESH_MINUTES * 60 * 1000);
}

async function stopWatcher() {
  if (pollTimer) clearInterval(pollTimer);
  if (membersTimer) clearInterval(membersTimer);
  pollTimer = null; membersTimer = null;

  await sendAlert("🛑 **Watcher stopped**");

  if (STORE.panel.channelId && STORE.panel.messageId) {
    try {
      const ch = await client.channels.fetch(STORE.panel.channelId);
      const msg = await ch.messages.fetch(STORE.panel.messageId);
      const embed = EmbedBuilder.from(msg.embeds[0] || new EmbedBuilder())
        .setFooter({ text: `Stopped at: ${nowStamp()}` });
      await msg.edit({ embeds: [embed] });
    } catch {}
  }
}

// ---- Slash commands (auto-register to each server the bot is in) ----
async function registerCommandsForAllGuilds() {
  const commands = [
    new SlashCommandBuilder()
      .setName("start")
      .setDescription("Start the watcher (creates/updates the live panel)")
      .addChannelOption(opt =>
        opt.setName("channel")
           .setDescription("Channel to use (leave empty to auto-pick)")
           .addChannelTypes(ChannelType.GuildText)
           .setRequired(false)
      ),
    new SlashCommandBuilder().setName("stop").setDescription("Stop the watcher"),
    new SlashCommandBuilder().setName("status").setDescription("Show status"),
    new SlashCommandBuilder().setName("list").setDescription("Show who is currently in the target game (ephemeral)"),
  ].map(c => c.toJSON());

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const guilds = await client.guilds.fetch();
  for (const [id] of guilds) {
    await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body: commands });
    console.log(`✓ Commands registered for guild ${id}`);
  }
}

// ---- Discord events ----
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommandsForAllGuilds();
  console.log("Slash commands ready. Use /start in your server.");
});

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    if (i.commandName === "start") {
      // pick channel: provided, or stored, or first text channel we can post in
      let ch = i.options.getChannel("channel");
      if (!ch) {
        if (STORE.panel.channelId) {
          ch = await client.channels.fetch(STORE.panel.channelId).catch(()=>null);
        }
        if (!ch) {
          const guild = await client.guilds.fetch(i.guildId);
          const full = await guild.channels.fetch();
          ch = full.find(c =>
            c?.type === ChannelType.GuildText &&
            c?.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
          );
        }
      }
      if (!ch) {
        await i.reply({ content: "I couldn't find a text channel I can write to. Please specify one: `/start channel:#alerts`", ephemeral: true });
        return;
      }
      await i.reply({ content: `Starting watcher in ${ch}`, ephemeral: true });
      await startWatcher(ch);
    }

    else if (i.commandName === "stop") {
      await stopWatcher();
      await i.reply({ content: "Watcher stopped.", ephemeral: true });
    }

    else if (i.commandName === "status") {
      const running = !!pollTimer;
      const count = watchedUserIds.length;
      await i.reply({
        content:
          `Status: **${running ? "RUNNING" : "STOPPED"}**\n` +
          `Watching: **${count}** users (rank ≥ ${CONFIG.MIN_RANK})\n` +
          `Poll: ${CONFIG.POLL_INTERVAL_MS/1000}s • Roster refresh: ${CONFIG.MEMBERS_REFRESH_MINUTES}m\n` +
          `Target place: ${CONFIG.TARGET_PLACE_ID}\n` +
          `Panel: ${STORE.panel.channelId ? `<#${STORE.panel.channelId}>` : "_not created_"}\n` +
          `Alerts: ${CONFIG.ALERTS_ENABLED ? "ON" : "OFF"}`,
        ephemeral: true
      });
    }

    else if (i.commandName === "list") {
      const ids = [...currentlyInGame];
      const names = await Promise.all(ids.map(id => fetchUsername(id)));
      await i.reply({
        content: names.length ? `Currently in game (${names.length}):\n${names.join(", ")}` : "No one is in the target game right now.",
        ephemeral: true
      });
    }

  } catch (e) {
    console.error(e);
    if (i.deferred || i.replied) await i.followUp({ content: `Error: ${e.message}`, ephemeral: true });
    else await i.reply({ content: `Error: ${e.message}`, ephemeral: true });
  }
});

client.login(TOKEN);

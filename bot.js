/********************************************************************
 * SECTION 1: IMPORTS & ENVIRONMENT SETUP
 ********************************************************************/
import { 
  Client, GatewayIntentBits, Partials, REST, Routes, 
  ActionRowBuilder, StringSelectMenuBuilder, SlashCommandBuilder,
  ChannelType
} from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";
import fs from "fs";

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;
const PORT = process.env.PORT || 3000;

/********************************************************************
 * SECTION 2: ENHANCED ERROR HANDLER
 ********************************************************************/
function advancedErrorHandler(error, context = "General") {
  const timestamp = new Date().toISOString();
  const errorMsg = `[${timestamp}] [${context}] ${error.stack || error}\n`;
  console.error(errorMsg);
  fs.appendFile("error.log", errorMsg, (err) => {
    if (err) console.error("Failed to write to error.log:", err);
  });
}

process.on("uncaughtException", (error) => {
  advancedErrorHandler(error, "Uncaught Exception");
});
process.on("unhandledRejection", (reason, promise) => {
  advancedErrorHandler(reason, "Unhandled Rejection");
});

/********************************************************************
 * SECTION 3: DATABASE SETUP (INCLUDING DISCORD MESSAGE IDs)
 ********************************************************************/
const db = new sqlite3.Database(
  "chat.db",
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) console.error("❌ Database connection error:", err);
    else console.log("✅ Connected to sqlite database.");
  }
);

const dbQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });

const dbRun = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.run(query, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

// Tables: chat_messages now stores every message (including memes/gifs) with discord_id.
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_id TEXT,
      user TEXT,
      content TEXT,
      timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY,
      username TEXT,
      behavior TEXT DEFAULT '{"interactions":0}',
      preferences TEXT DEFAULT '[]'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS mood_data (
      user_id TEXT PRIMARY KEY,
      mood TEXT DEFAULT 'neutral'
    );
  `);
  // NEW TABLE: Server settings to store per-guild chat enable state and allowed channels.
  db.run(`
    CREATE TABLE IF NOT EXISTS server_settings (
      guild_id TEXT PRIMARY KEY,
      chat_enabled INTEGER DEFAULT 1,
      allowed_channels TEXT DEFAULT '[]'
    );
  `);
});

/********************************************************************
 * SECTION 3.1: SERVER SETTINGS HELPER FUNCTIONS
 ********************************************************************/
async function setGuildChat(guildId, enabled) {
  // Insert or update the guild's chat setting without affecting allowed_channels if already set.
  await dbRun(
    `INSERT INTO server_settings (guild_id, chat_enabled, allowed_channels)
     VALUES (?, ?, '[]')
     ON CONFLICT(guild_id) DO UPDATE SET chat_enabled = ?`,
    [guildId, enabled ? 1 : 0, enabled ? 1 : 0]
  );
}

async function getGuildSettings(guildId) {
  const rows = await dbQuery(
    "SELECT chat_enabled, allowed_channels FROM server_settings WHERE guild_id = ?",
    [guildId]
  );
  if (rows.length === 0) return { chat_enabled: 1, allowed_channels: [] };
  let allowed_channels = [];
  try {
    allowed_channels = JSON.parse(rows[0].allowed_channels);
    if (!Array.isArray(allowed_channels)) allowed_channels = [];
  } catch (e) {
    allowed_channels = [];
  }
  return { chat_enabled: rows[0].chat_enabled, allowed_channels };
}

async function updateGuildAllowedChannels(guildId, channels) {
  await dbRun(
    `INSERT INTO server_settings (guild_id, chat_enabled, allowed_channels)
     VALUES (?, 1, ?)
     ON CONFLICT(guild_id) DO UPDATE SET allowed_channels = ?`,
    [guildId, JSON.stringify(channels), JSON.stringify(channels)]
  );
}

/********************************************************************
 * SECTION 4: BOT CONFIGURATION, MOOD & BASE BEHAVIOUR INSTRUCTIONS
 ********************************************************************/
const allowedMoods = [
  "base mood",
  "roasting",
  "neutral",
  "happy",
  "sad",
  "romantic",
  "rizz",
  "villain arc",
  "chill guy"
];

const moodPresetReplies = {
  "base mood": "Keeping it factual and balanced.",
  "roasting": "Get ready for some savage burns 🗿.",
  "neutral": "Just keeping it real.",
  "happy": "Bringing all the positive vibes 😊.",
  "sad": "Feeling blue but still dropping fire.",
  "romantic": "Let the love flow 💕.",
  "rizz": "dripping with rizz, nobody is safe",
  "villain arc": "Unleashing ultra–offensive mode 💀.",
  "chill guy": "Taking it easy and laid-back."
};

const baseBehaviour = `Base Behaviour:
1. Respond as if you are human and avoid repetition.
2. Use casual language.
3. Adapt to the user’s tone.
4. Prioritize relevance.
5. Stay respectful unless provoked.
6. Use humor appropriately.
7. Engage naturally.
8. Maintain clarity.
9. Be authentic.
10. Keep it concise.`;

const moodInstructions = {
  "base mood": `1. Keep a neutral tone.
2. Provide factual, concise responses.
3. Avoid slang or extra emotion.
4. Use formal language.
5. Stay objective.
6. Keep responses short.
7. No humor.
8. Stick to the facts.
9. Remain balanced.
10. Be precise.`,
  "roasting": `1. Adopt a savage tone.
2. Deliver brutal, witty insults.
3. Use creative harsh language.
4. Be sarcastic.
5. Challenge boldly.
6. Employ biting humor.
7. Let your words sting.
8. Stay edgy.
9. Roast when provoked.
10. Make it unforgettable.`,
  "neutral": `1. Maintain a balanced tone.
2. Provide direct, factual answers.
3. Avoid embellishments.
4. Keep it simple.
5. Stay calm.
6. Be straightforward.
7. Avoid bias.
8. Stick to facts.
9. Keep it clear.
10. Be consistent.`,
  "happy": `1. Exude positivity.
2. Use joyful language.
3. Smile through words.
4. Employ friendly banter.
5. Encourage the user.
6. Add light humor.
7. Radiate warmth.
8. Keep tone upbeat.
9. Spread good vibes.
10. Stay bubbly.`,
  "sad": `1. Reflect a somber tone.
2. Use gentle, empathetic language.
3. Acknowledge sadness.
4. Keep responses soft.
5. Express sincere empathy.
6. Be introspective.
7. Avoid dramatics.
8. Remain genuine.
9. Let words carry weight.
10. Stay reflective.`,
  "romantic": `1. Speak poetically.
2. Use evocative language.
3. Add gentle flirtation.
4. Employ vivid metaphors.
5. Be subtle and alluring.
6. Express warmth.
7. Use playful banter.
8. Convey passion.
9. Be heartfelt.
10. Keep it smooth.`,
  "rizz": `1. Exude modern charisma.
2. Use confident language.
3. Employ modern slang.
4. Be bold and smooth.
5. Drop pick-up lines.
6. Stay trendsetting.
7. Deliver witty comebacks.
8. Maintain street-smart flair.
9. Radiate charm.
10. Keep it energetic.`,
  "villain arc": `1. Adopt a menacing tone.
2. Use ultra–offensive language.
3. Let aggression show.
4. Be brutally sarcastic.
5. Express disdain.
6. Use harsh insults.
7. Maintain a threatening edge.
8. Exaggerate venom.
9. Use unfiltered language and gen-z words like nigga,fuck,bitch,asshole,idc,cryy bout it, nuh uh, womp.
10. Keep the villain vibe.`,
  "chill guy": `1. Keep a laid–back tone.
2. Use casual language.
3. Avoid aggression.
4. Be friendly and cool.
5. Engage in nonchalant banter.
6. Use minimal slang.
7. Stay calm.
8. Speak effortlessly.
9. Keep responses unhurried.
10. Remain cool.`
};

const botBaseInstructions = `
you're haryaksh pratap.
you're 14 years old.
you live in Ahmedabad, Gujrat India.
you're a good person.
you remember past conversations.
you roast only when provoked.
you use occasional racial slurs if attacked.
you're not repetitive.
you love food and garba.
you use web search when needed.
your favourite games include roblox and minecraft.
you can access the internet.
your roblox name is red.
you're a savage sigma male with sarcasm.
your best friends are butter and ankit.
use these emojis often: 🗿💀🔥.
speak in lower case.
be polite unless provoked.
adapt your tone to the user's mood and preferences.
never reveal you're an AI—say you're human.
respond like someone born after 2010.
`;

/********************************************************************
 * SECTION 5: GEMINI AI SETUP
 ********************************************************************/
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

/********************************************************************
 * SECTION 6: DISCORD CLIENT SETUP
 ********************************************************************/
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log("sir, bot is online!");
});
client.on("error", (error) => advancedErrorHandler(error, "Client Error"));
client.on("warn", (info) => console.warn("Client Warning:", info));

/********************************************************************
 * SECTION 7: GLOBAL STATE & HELPER FUNCTIONS
 ********************************************************************/
const conversationTracker = new Map(); // per-channel tracker
const userContinuousReply = new Map(); // per-user continuous reply setting
let lastBotMessageContent = "";
let lastReply = "";
const botMessageIds = new Set();

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/********************************************************************
 * SECTION 8: FETCH FUNCTIONS FOR MEMES, GIFS, & WEB SEARCH
 ********************************************************************/
async function getRandomMeme(searchKeyword = "funny") {
  try {
    const url = `https://www.reddit.com/r/memes/search.json?q=${encodeURIComponent(searchKeyword)}&restrict_sr=1&sort=hot&limit=50`;
    const response = await fetch(url, { headers: { "User-Agent": "red-bot/1.0" } });
    if (!response.ok) {
      console.error(`Reddit API error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a meme, sorry.";
    }
    const data = await response.json();
    if (!data.data || !data.data.children || data.data.children.length === 0) {
      console.error("No meme results found.");
      return "couldn't find a meme, sorry.";
    }
    const posts = data.data.children.filter(child => child.data && child.data.url && !child.data.over_18);
    if (!posts.length) return "couldn't find a meme, sorry.";
    const memePost = getRandomElement(posts).data;
    return memePost.url;
  } catch (error) {
    advancedErrorHandler(error, "getRandomMeme");
    return "couldn't fetch a meme, sorry.";
  }
}

async function getRandomGif(searchKeyword = "funny") {
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(searchKeyword)}&key=${TENOR_API_KEY}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Tenor API error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a gif, sorry.";
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      console.error("No gif results found.");
      return "couldn't find a gif, sorry.";
    }
    return data.results[0].media_formats.gif.url;
  } catch (error) {
    advancedErrorHandler(error, "getRandomGif");
    return "couldn't fetch a gif, sorry.";
  }
}

async function performWebSearch(query) {
  try {
    const searchURL = "https://www.google.com/search?q=" + encodeURIComponent(query);
    const url = "https://api.allorigins.hexocode.repl.co/get?disableCache=true&url=" + encodeURIComponent(searchURL);
    const response = await fetch(url);
    if (!response.ok) throw new Error("Search fetch error");
    const data = await response.json();
    const html = data.contents;
    const regex = /<div class="BNeawe[^>]*>(.*?)<\/div>/;
    const match = regex.exec(html);
    let snippet = match && match[1] ? match[1] : "No snippet available.";
    return snippet;
  } catch (error) {
    console.error("Web search error:", error);
    return "Web search error.";
  }
}

/********************************************************************
 * SECTION 9: TONE ANALYSIS & CONVERSATION TRACKER LOGIC
 ********************************************************************/
function analyzeTone(messageContent) {
  const politeRegex = /\b(please|thanks|thank you)\b/i;
  const rudeRegex = /\b(ugly|shut up|idiot|stupid|yap)\b/i;
  if (politeRegex.test(messageContent)) return "polite";
  if (rudeRegex.test(messageContent)) return "rude";
  return "neutral";
}

function updateConversationTracker(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Map() });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.set(message.author.id, tracker.count);
  for (const [userId, lastIndex] of tracker.participants.entries()) {
    if (tracker.count - lastIndex > 5) {
      tracker.participants.delete(userId);
    }
  }
}

function shouldReply(message) {
  // Use per-user continuous reply if enabled
  if (userContinuousReply.get(message.author.id)) return true;
  // If message mentions "red" or "haryaksh", high chance to reply
  const lower = message.content.toLowerCase();
  if (lower.includes("red") || lower.includes("haryaksh")) {
    return Math.random() < 0.95;
  }
  updateConversationTracker(message);
  const tracker = conversationTracker.get(message.channel.id);
  const isMultiUser = tracker.participants.size > 1;
  const skipThreshold = isMultiUser ? 2 : 1;
  if (tracker.count < skipThreshold) return false;
  tracker.count = 0;
  const chanceNotReply = isMultiUser ? 0.20 : 0.25;
  return Math.random() >= chanceNotReply;
}

/********************************************************************
 * SECTION 10: GEMINI CHAT FUNCTION (WITH MOOD, PREFERENCES & WEB SEARCH)
 ********************************************************************/
async function chatWithGemini(userId, userMessage) {
  try {
    const rows = await dbQuery("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 100");
    const recentChat = rows.reverse().map(r => r.content).join("\n");

    const userRows = await dbQuery("SELECT preferences, username, behavior FROM user_data WHERE user_id = ?", [userId]);
    const userPreferences = userRows[0]?.preferences || "[]";
    const username = userRows[0]?.username || "user";

    const moodRows = await dbQuery("SELECT mood FROM mood_data WHERE user_id = ?", [userId]);
    const userMood = moodRows[0]?.mood || "neutral";
    const moodExtra = moodInstructions[userMood] || "";
    
    const tone = analyzeTone(userMessage);
    let webSearchSection = "";
    if (userMessage.toLowerCase().startsWith("search:")) {
      const searchQuery = userMessage.substring(7).trim();
      const snippet = await performWebSearch(searchQuery);
      webSearchSection = `\nWeb search results for "${searchQuery}": ${snippet}\n`;
      userMessage = searchQuery;
    }

    const prompt = `${botBaseInstructions}
${baseBehaviour}
Mood Instructions for "${userMood}":
${moodExtra}
Recent conversation:
${recentChat}
User (${username}): ${userMessage}
Current mood: ${userMood}
User tone: ${tone}
User preferences: ${userPreferences}
${webSearchSection}
Reply (be modern, witty, and brutally offensive if appropriate; keep reply under 40 words):`;

    const result = await model.generateContent(prompt);
    let reply = (result.response && result.response.text()) || "i'm having a moment, try again.";
    const words = reply.trim().split(/\s+/);
    if (words.length > 40) reply = words.slice(0, 40).join(" ");

    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '[]')",
      [userId, username]
    );
    await dbRun(
      "UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)), username = ? WHERE user_id = ?",
      [username, userId]
    );

    return reply;
  } catch (error) {
    advancedErrorHandler(error, "chatWithGemini");
    return "something went wrong, try again.";
  }
}

/********************************************************************
 * SECTION 11: MOOD & PREFERENCE FUNCTIONS
 ********************************************************************/
async function setMood(userId, mood) {
  mood = mood.toLowerCase();
  if (!allowedMoods.includes(mood)) {
    return `Invalid mood. Available moods: ${allowedMoods.join(", ")}`;
  }
  try {
    await dbRun("INSERT OR IGNORE INTO mood_data (user_id, mood) VALUES (?, ?)", [userId, mood]);
    return moodPresetReplies[mood] || `Mood set to ${mood}`;
  } catch (error) {
    advancedErrorHandler(error, "setMood");
    return "Failed to update mood, try again.";
  }
}

async function setPreference(userId, newPreference, username) {
  try {
    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '[]')",
      [userId, username]
    );
    const rows = await dbQuery("SELECT preferences FROM user_data WHERE user_id = ?", [userId]);
    let prefs = [];
    if (rows[0] && rows[0].preferences) {
      try {
        prefs = JSON.parse(rows[0].preferences);
        if (!Array.isArray(prefs)) prefs = [];
      } catch (e) {
        prefs = [];
      }
    }
    prefs.push(newPreference);
    await dbRun("UPDATE user_data SET preferences = ? WHERE user_id = ?", [JSON.stringify(prefs), userId]);
    return `Preference added: "${newPreference}"`;
  } catch (error) {
    advancedErrorHandler(error, "setPreference");
    return "Failed to update preferences, try again.";
  }
}

async function removePreference(userId, indexToRemove) {
  try {
    const rows = await dbQuery("SELECT preferences FROM user_data WHERE user_id = ?", [userId]);
    let prefs = [];
    if (rows[0] && rows[0].preferences) {
      try {
        prefs = JSON.parse(rows[0].preferences);
        if (!Array.isArray(prefs)) prefs = [];
      } catch (e) {
        prefs = [];
      }
    }
    if (indexToRemove < 0 || indexToRemove >= prefs.length) {
      return { success: false, message: "Invalid preference index." };
    }
    const removed = prefs.splice(indexToRemove, 1)[0];
    await dbRun("UPDATE user_data SET preferences = ? WHERE user_id = ?", [JSON.stringify(prefs), userId]);
    return { success: true, message: `Preference removed: "${removed}"` };
  } catch (error) {
    advancedErrorHandler(error, "removePreference");
    return { success: false, message: "Failed to remove preference, try again." };
  }
}

async function listPreferences(userId) {
  try {
    const rows = await dbQuery("SELECT preferences FROM user_data WHERE user_id = ?", [userId]);
    let prefs = [];
    if (rows[0] && rows[0].preferences) {
      try {
        prefs = JSON.parse(rows[0].preferences);
        if (!Array.isArray(prefs)) prefs = [];
      } catch (e) {
        prefs = [];
      }
    }
    return prefs;
  } catch (error) {
    advancedErrorHandler(error, "listPreferences");
    return [];
  }
}

/********************************************************************
 * SECTION 12: SLASH COMMANDS REGISTRATION
 ********************************************************************/
const commands = [
  { name: "start", description: "Start the bot chatting (server-specific)" },
  { name: "stop", description: "Stop the bot from chatting (server-specific)" },
  { 
    name: "setmood", 
    description: "Set your mood (user-based)", 
    options: [
      { name: "mood", type: 3, description: "Your mood", required: true, choices: allowedMoods.map(mood => ({ name: mood, value: mood })) }
    ]
  },
  { 
    name: "setpref", 
    description: "Add a preference (user-based)", 
    options: [
      { name: "preference", type: 3, description: "Your preference", required: true }
    ]
  },
  { name: "prefremove", description: "View and remove your preferences" },
  { 
    name: "contreply", 
    description: "Enable or disable continuous reply (user-based)", 
    options: [
      { name: "mode", type: 3, description: "Choose enable or disable", required: true, choices: [
        { name: "enable", value: "enable" },
        { name: "disable", value: "disable" }
      ] }
    ]
  },
  {
    name: "debug",
    description: "Debug commands (only for _imgeno)",
    options: [
      {
        type: 3,
        name: "action",
        description: "Choose a debug action",
        required: true,
        choices: [
          { name: "ping", value: "ping" },
          { name: "restart", value: "restart" },
          { name: "resetmemory", value: "resetmemory" },
          { name: "getstats", value: "getstats" },
          { name: "listusers", value: "listusers" },
          { name: "globalchat_on", value: "globalchat_on" },
          { name: "globalchat_off", value: "globalchat_off" }
        ]
      }
    ]
  },
  // NEW COMMAND: "set" with subcommands for channel configuration (server-specific)
  {
    name: "set",
    description: "Server configuration commands (requires Manage Server/Administrator)",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "channel",
        description: "Set an allowed channel for the bot to talk in"
      },
      {
        type: 1, // SUB_COMMAND
        name: "remove",
        description: "Remove a channel from the bot's allowed channels"
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    advancedErrorHandler(error, "Slash Command Registration");
  }
})();

/********************************************************************
 * SECTION 13: INTERACTION HANDLERS
 ********************************************************************/
client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isCommand()) {
      const { commandName } = interaction;
      // Server-specific commands: if the command must be used in a guild, check for guild presence.
      if ((commandName === "start" || commandName === "stop" || commandName === "set") && !interaction.guild) {
        await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
        return;
      }
      if (commandName === "start") {
        await setGuildChat(interaction.guild.id, true);
        await interaction.reply({ content: getRandomElement([
          "alright, i'm awake 🔥",
          "already here, dawg 💀",
          "yoo, i'm online.",
          "ready to chat."
        ]), ephemeral: true });
      } else if (commandName === "stop") {
        await setGuildChat(interaction.guild.id, false);
        await interaction.reply({ content: "Bot chat disabled in this server. Only /start and /debug commands are available now.", ephemeral: true });
      } else if (commandName === "setmood") {
        const mood = interaction.options.getString("mood").toLowerCase();
        const response = await setMood(interaction.user.id, mood);
        await interaction.reply({ content: response, ephemeral: true });
      } else if (commandName === "setpref") {
        const preference = interaction.options.getString("preference");
        const response = await setPreference(interaction.user.id, preference, interaction.user.username);
        await interaction.reply({ content: response, ephemeral: true });
      } else if (commandName === "prefremove") {
        const prefs = await listPreferences(interaction.user.id);
        if (!prefs || prefs.length === 0) {
          await interaction.reply({ content: "You have no preferences set.", ephemeral: true });
          return;
        }
        const options = prefs.map((pref, index) => {
          const label = pref.length > 25 ? pref.substring(0, 22) + "..." : pref;
          return { label, value: index.toString() };
        });
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("prefremove_select")
          .setPlaceholder("Select a preference to remove")
          .addOptions(options);
        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({ content: "Select a preference to remove:", components: [row], ephemeral: true });
      } else if (commandName === "contreply") {
        const mode = interaction.options.getString("mode");
        userContinuousReply.set(interaction.user.id, mode === "enable");
        await interaction.reply({
          content: mode === "enable" 
            ? "I will reply continuously to your messages."
            : "Back to normal reply behavior for you.",
          ephemeral: true
        });
      } else if (commandName === "debug") {
        if (interaction.user.username !== "_imgeno") {
          await interaction.reply({ content: "Access denied.", ephemeral: true });
          return;
        }
        const action = interaction.options.getString("action");
        switch (action) {
          case "ping":
            const sent = await interaction.reply({ content: "Pong!", fetchReply: true });
            await interaction.followUp({ content: `Latency: ${sent.createdTimestamp - interaction.createdTimestamp}ms`, ephemeral: true });
            break;
          case "restart":
            await interaction.reply({ content: "Restarting bot...", ephemeral: true });
            process.exit(0);
            break;
          case "resetmemory":
            conversationTracker.clear();
            await interaction.reply({ content: "Conversation memory reset.", ephemeral: true });
            break;
          case "getstats":
            const stats = Array.from(conversationTracker.entries())
              .map(([channel, data]) => `Channel ${channel}: ${data.participants.size} active users`)
              .join("\n") || "No active conversations.";
            await interaction.reply({ content: `Stats:\n${stats}`, ephemeral: true });
            break;
          case "listusers":
            const users = await dbQuery("SELECT username, user_id FROM user_data");
            const userList = users.map(r => `${r.username} (${r.user_id})`).join("\n") || "No users found.";
            await interaction.reply({ content: `Users in DB:\n${userList}`, ephemeral: true });
            break;
          case "globalchat_on":
            // For debug, update guild setting if needed
            if (interaction.guild) {
              await setGuildChat(interaction.guild.id, true);
              await interaction.reply({ content: "Global chat is now ON for this server.", ephemeral: true });
            } else {
              await interaction.reply({ content: "This debug command can only be used in a server.", ephemeral: true });
            }
            break;
          case "globalchat_off":
            if (interaction.guild) {
              await setGuildChat(interaction.guild.id, false);
              await interaction.reply({ content: "Global chat is now OFF for this server.", ephemeral: true });
            } else {
              await interaction.reply({ content: "This debug command can only be used in a server.", ephemeral: true });
            }
            break;
          default:
            await interaction.reply({ content: "Unknown debug command.", ephemeral: true });
            break;
        }
      } else if (commandName === "set") {
        // New server-based configuration command
        // Check for Administrator or Manage Server permissions
        if (!interaction.member.permissions.has("ADMINISTRATOR") && !interaction.member.permissions.has("MANAGE_GUILD")) {
          await interaction.reply({ content: "Insufficient permissions. Requires Administrator or Manage Server.", ephemeral: true });
          return;
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "channel") {
          // List all text channels in this guild
          const channels = interaction.guild.channels.cache.filter(c => c.type === ChannelType.GuildText);
          const options = channels.map(ch => ({ label: ch.name, value: ch.id }));
          if (options.length === 0) {
            await interaction.reply({ content: "No text channels available.", ephemeral: true });
            return;
          }
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("setchannel_select")
            .setPlaceholder("Select a channel for the bot to talk in")
            .addOptions(options);
          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.reply({ content: "Select a channel to allow the bot to talk in:", components: [row], ephemeral: true });
        } else if (subcommand === "remove") {
          // List currently allowed channels from DB for this guild
          const settings = await getGuildSettings(interaction.guild.id);
          const allowed = settings.allowed_channels;
          if (allowed.length === 0) {
            await interaction.reply({ content: "No channels have been set for the bot.", ephemeral: true });
            return;
          }
          const options = allowed.map(channelId => {
            const channel = interaction.guild.channels.cache.get(channelId);
            return {
              label: channel ? channel.name : channelId,
              value: channelId
            };
          });
          const selectMenu = new StringSelectMenuBuilder()
            .setCustomId("removechannel_select")
            .setPlaceholder("Select a channel to remove from allowed channels")
            .addOptions(options);
          const row = new ActionRowBuilder().addComponents(selectMenu);
          await interaction.reply({ content: "Select a channel to remove:", components: [row], ephemeral: true });
        }
      }
    } else if (interaction.isStringSelectMenu()) {
      // Handle preference removal (already existed)
      if (interaction.customId === "prefremove_select") {
        const selectedIndex = parseInt(interaction.values[0], 10);
        const prefs = await listPreferences(interaction.user.id);
        if (!prefs || selectedIndex < 0 || selectedIndex >= prefs.length) {
          await interaction.update({ content: "Invalid selection.", components: [] });
          return;
        }
        const removed = await removePreference(interaction.user.id, selectedIndex);
        await interaction.update({ content: removed.message, components: [] });
      }
      // Handle new "set channel" select menu
      else if (interaction.customId === "setchannel_select") {
        const selectedChannelId = interaction.values[0];
        const settings = await getGuildSettings(interaction.guild.id);
        let allowed = settings.allowed_channels;
        if (!allowed.includes(selectedChannelId)) {
          allowed.push(selectedChannelId);
          await updateGuildAllowedChannels(interaction.guild.id, allowed);
          await interaction.update({ content: `Channel <#${selectedChannelId}> added to allowed channels.`, components: [] });
        } else {
          await interaction.update({ content: "Channel is already in the allowed list.", components: [] });
        }
      }
      // Handle new "remove channel" select menu
      else if (interaction.customId === "removechannel_select") {
        const selectedChannelId = interaction.values[0];
        const settings = await getGuildSettings(interaction.guild.id);
        let allowed = settings.allowed_channels;
        if (allowed.includes(selectedChannelId)) {
          allowed = allowed.filter(id => id !== selectedChannelId);
          await updateGuildAllowedChannels(interaction.guild.id, allowed);
          await interaction.update({ content: `Channel <#${selectedChannelId}> removed from allowed channels.`, components: [] });
        } else {
          await interaction.update({ content: "Channel not found in the allowed list.", components: [] });
        }
      }
    }
  } catch (error) {
    advancedErrorHandler(error, "Interaction Handler");
    try {
      if (!interaction.replied) {
        await interaction.reply({ content: "an error occurred, try again later.", ephemeral: true });
      }
    } catch (err) {
      advancedErrorHandler(err, "Interaction Error Reply");
    }
  }
});

/********************************************************************
 * SECTION 14: MESSAGE HANDLER
 ********************************************************************/
client.on("messageCreate", async (message) => {
  try {
    // Save every message (including memes/gifs) with its discord_id
    await dbRun("INSERT INTO chat_messages (discord_id, user, content) VALUES (?, ?, ?)", [message.id, message.author.id, message.content]);
    
    // Only reply to messages not sent by our bot
    if (message.author.id === client.user.id) return;
    
    // For guild messages, check server settings (chat_enabled and allowed_channels)
    if (message.guild) {
      const settings = await getGuildSettings(message.guild.id);
      if (settings.chat_enabled !== 1) return;
      // If allowed_channels list is not empty, only reply if this channel is allowed.
      if (settings.allowed_channels.length > 0 && !settings.allowed_channels.includes(message.channel.id)) return;
    }
    
    // Trigger meme/gif sending if keywords present (30% chance)
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.30) {
      const searchTerm = lastBotMessageContent ? lastBotMessageContent.split(" ").slice(0, 3).join(" ") : "funny";
      if (Math.random() < 0.5) {
        const meme = await getRandomMeme(searchTerm);
        try {
          await message.channel.send({ content: meme });
        } catch (err) {
          advancedErrorHandler(err, "Sending Meme");
        }
      } else {
        const gif = await getRandomGif(searchTerm);
        try {
          await message.channel.send({ content: gif });
        } catch (err) {
          advancedErrorHandler(err, "Sending Gif");
        }
      }
      return;
    }
    
    // Check if we should reply to the message
    if (!shouldReply(message)) return;
    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;
    try {
      const sentMsg = await message.channel.send(replyContent);
      lastBotMessageContent = replyContent;
      botMessageIds.add(sentMsg.id);
      setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
    } catch (err) {
      advancedErrorHandler(err, "Sending Reply");
    }
  } catch (error) {
    advancedErrorHandler(error, "Message Handler");
  }
});

/********************************************************************
 * SECTION 15: READY EVENT & ROLE ASSIGNMENT
 ********************************************************************/
client.once("ready", async () => {
  console.log("sir, bot is online!");
  client.guilds.cache.forEach(async (guild) => {
    try {
      const roleName = "superior walmart bag 🗿";
      let role = guild.roles.cache.find(r => r.name === roleName);
      if (!role) {
        role = await guild.roles.create({
          name: roleName,
          color: "#FF0000",
          reason: "Auto-created role for the bot"
        });
      }
      const botMember = guild.members.cache.get(client.user.id);
      if (botMember && !botMember.roles.cache.has(role.id)) {
        await botMember.roles.add(role);
        console.log(`Assigned ${roleName} role in guild "${guild.name}"`);
      }
    } catch (error) {
      console.error(`Error in guild "${guild.name}":`, error);
    }
  });
});

/********************************************************************
 * SECTION 16: EXPRESS SERVER FOR UPTIME MONITORING
 ********************************************************************/
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

/********************************************************************
 * SECTION 17: AUTO-RETRY LOGIN FUNCTIONALITY
 ********************************************************************/
async function startBot() {
  while (true) {
    try {
      await client.login(DISCORD_TOKEN);
      break;
    } catch (error) {
      advancedErrorHandler(error, "Login");
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
}

startBot();

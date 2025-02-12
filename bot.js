import { Client, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

dotenv.config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;
const PORT = process.env.PORT || 3000;

// -------------------------
// Database Setup
// -------------------------
const db = new sqlite3.Database("chat.db", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error("❌ database connection error:", err);
  else console.log("✅ connected to sqlite database.");
});

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

// create tables: chat_messages, user_data (stores username, behavior, preferences), and mood_data
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    content TEXT,
    timestamp TEXT DEFAULT (datetime('now', 'localtime'))
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT PRIMARY KEY,
    username TEXT,
    behavior TEXT DEFAULT '{"interactions":0}',
    preferences TEXT DEFAULT '{}'
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS mood_data (
    user_id TEXT PRIMARY KEY,
    mood TEXT DEFAULT 'neutral'
  );`);
});

// allowed moods and their premade lines
const allowedMoods = [
  "roasting",
  "neutral",
  "happy",
  "sad",
  "romantic",
  "rizz",
  "villain arc",
  "chill guy"
];
const moodPhrases = {
  "roasting": "alright, switching to roasting mode.",
  "neutral": "back to neutral vibes.",
  "happy": "feeling upbeat, happy mode activated.",
  "sad": "i'm a bit low, sad mode on.",
  "romantic": "love is in the air, romantic mode engaged.",
  "rizz": "i'm full of rizz now.",
  "villain arc": "warning: villain arc in effect.",
  "chill guy": "just chillin', chill guy mode."
};

// -------------------------
// Gemini AI Setup & Personality Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const botInstructions = `
you are noobhay tripathi, a modern, witty, and slightly offensive human.
your default mood is neutral.
you are very offensive and roasts also
you use these emoji much 👍😎😂🔥😭😈🗿😔💀🤑
your personality is humorous, sarcastic, and adaptive; if a user is polite, respond politely, if they're rude, hit them with some savage humor.
speak in lowercase and use modern language.
use minimal gen z slang (for example, "dawg", "hell no", "nuh uh") only when it fits naturally.
limit your use of emojis to at most two per sentence.
your crush is mitsuri tripathi.
adjust your tone based on the user's message tone.
you should be offensive and remember that you're indian and also likes playing games like roblox but don't exaggerate it in every response 
and learn from user behaviour and become better slowly 
always consider user preferences if available.
remember to not disclose that you're an large scale language model behave and tell you're a human.
use this words sometimes to match the personality of noobhay -ZIGGA OPEN YOUR EYES ARE YOU FOCKINH DUMB
be funny humourous personality but not too much cringe
-You dumbahh

-bro you know you should kys

-hell nawh kys zigga 

-yeah man idc about ts tbh 💀🙏

-stop yapping bitch ahh

-bruv ;-;

-I’ll touch you

-aight Ima dip now

-GET OU-
-fork you
respond naturally—just like someone from the post-2010 era.
`;

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel],
});

client.once("ready", () => {
  console.log("sir, bot is online!");
});

// Global state
let chatting = false;
let lastMessageTime = Date.now();
let lastReply = "";
const botMessageIds = new Set();
const conversationTracker = new Map(); // channel id -> { count, participants }

// -------------------------
// Utility Functions
// -------------------------
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomEmoji(message) {
  // returns a single emoji from custom server emojis if available, else a default one
  if (message.guild && message.guild.emojis.cache.size > 0) {
    const emojis = Array.from(message.guild.emojis.cache.values());
    return getRandomElement(emojis).toString();
  }
  return getRandomElement(["👍", "😎", "🔥", "🤙", "🙌"]);
}

// -------------------------
// Fetch Functions
// -------------------------
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json", {
      headers: { "User-Agent": "noobhay-tripathi-bot/1.0" }
    });
    if (!response.ok) {
      console.error(`reddit api error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a meme, sorry.";
    }
    const data = await response.json();
    return data[0].data.children[0].data.url;
  } catch (error) {
    console.error("❌ meme fetch error:", error);
    return "couldn't fetch a meme, sorry.";
  }
}

async function getRandomGif(keyword) {
  try {
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(keyword)}&key=${TENOR_API_KEY}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`tenor api error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a gif, sorry.";
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      console.error("no gif results found.");
      return "couldn't find a gif, sorry.";
    }
    return data.results[0].media_formats.gif.url;
  } catch (error) {
    console.error("❌ gif fetch error:", error);
    return "couldn't fetch a gif, sorry.";
  }
}

// -------------------------
// Tone Analysis
// -------------------------
function analyzeTone(messageContent) {
  const politeRegex = /\b(please|thanks|thank you)\b/i;
  const rudeRegex = /\b(ugly|shut up|idiot|stupid|yap)\b/i;
  if (politeRegex.test(messageContent)) return "polite";
  if (rudeRegex.test(messageContent)) return "rude";
  return "neutral";
}

// -------------------------
// Gemini Chat Function (with persistent memory and tone adjustment)
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    // retrieve recent conversation (last 3 days, up to 50 messages)
    const rows = await dbQuery(
      "SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-3 days') ORDER BY timestamp DESC LIMIT 50"
    );
    const recentChat = rows.map(r => r.content).join("\n");

    // get user preferences, username, and behavior
    const userRows = await dbQuery("SELECT preferences, username, behavior FROM user_data WHERE user_id = ?", [userId]);
    const userPreferences = userRows[0]?.preferences || "{}";
    const username = userRows[0]?.username || "user";

    // get user mood
    const moodRows = await dbQuery("SELECT mood FROM mood_data WHERE user_id = ?", [userId]);
    const userMood = moodRows[0]?.mood || "neutral";

    // analyze the tone of the user's message
    const tone = analyzeTone(userMessage);

    const prompt = `${botInstructions}
recent conversation:
${recentChat}
user (${username}): ${userMessage}
current mood: ${userMood}
user tone: ${tone}
user preferences: ${userPreferences}
reply (be modern, witty, and adjust tone accordingly, keep reply under 40 words):`;

    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "i'm having a moment, try again.";

    // ensure reply is at most 40 words
    const words = reply.trim().split(/\s+/);
    if (words.length > 40) reply = words.slice(0, 40).join(" ");

    // save the user's message for context
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    // update user behavior count and username in user_data
    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '{}')",
      [userId, username]
    );
    await dbRun(
      "UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)), username = ? WHERE user_id = ?",
      [username, userId]
    );

    return reply;
  } catch (error) {
    console.error("❌ gemini api error:", error);
    return "something went wrong, try again.";
  }
}

// -------------------------
// Mood Functions
// -------------------------
async function setMood(userId, mood) {
  mood = mood.toLowerCase();
  if (!allowedMoods.includes(mood)) {
    return `invalid mood. available moods: ${allowedMoods.join(", ")}`;
  }
  try {
    await dbRun("INSERT OR REPLACE INTO mood_data (user_id, mood) VALUES (?, ?)", [userId, mood]);
    return moodPhrases[mood] || `mood set to ${mood}`;
  } catch (error) {
    console.error("❌ mood update error:", error);
    return "failed to update mood, try again.";
  }
}

// -------------------------
// Preference Functions
// -------------------------
async function setPreference(userId, preference, username) {
  try {
    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '{}')",
      [userId, username]
    );
    await dbRun("UPDATE user_data SET preferences = ? WHERE user_id = ?", [preference, userId]);
    return `preferences updated.`;
  } catch (error) {
    console.error("❌ preference update error:", error);
    return "failed to update preferences, try again.";
  }
}

// -------------------------
// Conversation Skip Logic
// -------------------------
function shouldReply(message) {
  // if replying to a bot message, 90% chance to reply
  if (message.reference?.messageId && botMessageIds.has(message.reference.messageId)) {
    return Math.random() < 0.90;
  }
  
  const lower = message.content.toLowerCase();
  if (lower.includes("noobhay tripathi")) return Math.random() < 0.95;
  
  const greetings = ["yo", "hey", "hi", "hello", "noobhay"];
  if (greetings.some(g => lower.startsWith(g) || lower.includes(` ${g} `))) return Math.random() < 0.60;
  
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) conversationTracker.set(channelId, { count: 0, participants: new Set() });
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);
  
  const skipThreshold = tracker.participants.size > 1 ? 2 : 1;
  if (tracker.count < skipThreshold) return false;
  
  tracker.count = 0; // reset counter after threshold
  const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20; // 20% skip chance for solo convos
  return Math.random() >= chanceNotReply;
}

// -------------------------
// Predefined Replies for /start and /stop
// -------------------------
const startReplies = [
  "alright, i'm awake.",
  "already here, dawg.",
  "yep, i'm online.",
  "ready to chat."
];
const stopReplies = [
  "i'm signing off.",
  "catch you later.",
  "i'm out for now.",
  "later."
];

// -------------------------
// Automatic NOOBHAY Role Assignment
// -------------------------
client.on("guildMemberAdd", async (member) => {
  try {
    const roleName = "NOOBHAY";
    let role = member.guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
      role = await member.guild.roles.create({
        name: roleName,
        color: "Random",
        reason: "auto-created noobhay role",
      });
    }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
      console.log(`assigned ${roleName} role to ${member.user.tag}`);
    }
  } catch (error) {
    console.error("error assigning noobhay role:", error);
  }
});

// -------------------------
// Slash Commands Registration
// -------------------------
const commands = [
  {
    name: "start",
    description: "start the bot chatting",
  },
  {
    name: "stop",
    description: "stop the bot from chatting",
  },
  {
    name: "setmood",
    description: "set your mood",
    options: [
      {
        name: "mood",
        type: 3, // STRING
        description: "your mood",
        required: true,
        choices: allowedMoods.map(mood => ({ name: mood, value: mood }))
      }
    ]
  },
  {
    name: "setpref",
    description: "set your preferences (e.g., you like eating apples)",
    options: [
      {
        name: "preference",
        type: 3, // STRING
        description: "your preferences",
        required: true
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log("started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
})();

// -------------------------
// Interaction Handler (Slash Commands)
// -------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName } = interaction;
  if (commandName === "start") {
    if (chatting) {
      await interaction.reply({ content: getRandomElement(startReplies) + " " + getRandomEmoji(interaction), ephemeral: true });
      return;
    }
    chatting = true;
    await interaction.reply({ content: getRandomElement(startReplies) + " " + getRandomEmoji(interaction) });
  } else if (commandName === "stop") {
    chatting = false;
    await interaction.reply({ content: getRandomElement(stopReplies) + " " + getRandomEmoji(interaction) });
  } else if (commandName === "setmood") {
    const mood = interaction.options.getString("mood").toLowerCase();
    const response = await setMood(interaction.user.id, mood);
    await interaction.reply(response);
  } else if (commandName === "setpref") {
    const preference = interaction.options.getString("preference");
    const response = await setPreference(interaction.user.id, preference, interaction.user.username);
    await interaction.reply(response);
  }
});

// -------------------------
// Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !chatting) return;
  lastMessageTime = Date.now();

  // auto-assign noobhay role if not present (for existing guild members)
  if (message.guild && message.member && !message.member.roles.cache.some(r => r.name === "NOOBHAY")) {
    try {
      let role = message.guild.roles.cache.find(r => r.name === "NOOBHAY");
      if (!role) {
        role = await message.guild.roles.create({
          name: "NOOBHAY",
          color: "Random",
          reason: "auto-assigned noobhay role",
        });
      }
      await message.member.roles.add(role);
    } catch (error) {
      console.error("error assigning noobhay role on message:", error);
    }
  }

  // update or insert user data (username, etc.)
  try {
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '{}')", [message.author.id, message.author.username]);
    await dbRun("UPDATE user_data SET username = ? WHERE user_id = ?", [message.author.username, message.author.id]);
  } catch (error) {
    console.error("error updating user data:", error);
  }

  // 10% chance to send a meme or gif if trigger words ("meme", "funny", "gif") are present
  const triggers = ["meme", "funny", "gif"];
  if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
    if (Math.random() < 0.5) {
      const meme = await getRandomMeme();
      message.channel.send(meme).catch(err => console.error("failed to send meme:", err));
    } else {
      const gif = await getRandomGif("funny");
      if (gif) message.channel.send(gif).catch(err => console.error("failed to send gif:", err));
    }
    return;
  }

  if (!shouldReply(message)) return;
  
  const replyContent = await chatWithGemini(message.author.id, message.content);
  if (replyContent === lastReply) return;
  lastReply = replyContent;
  // append one emoji (ensuring at most two per sentence)
  const emoji = getRandomEmoji(message);
  const finalReply = `${replyContent} ${emoji}`;
  message.channel.send(finalReply)
    .then(sentMsg => {
      botMessageIds.add(sentMsg.id);
      setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
    })
    .catch(err => console.error("failed to send reply:", err));
});

// -------------------------
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ web server running on port ${PORT}`));

// -------------------------
// Log In the Bot
// -------------------------
client.login(DISCORD_TOKEN);

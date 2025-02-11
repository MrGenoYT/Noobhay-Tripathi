import { Client, GatewayIntentBits, Partials } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

// -------------------------
// Load Environment Variables
// -------------------------
dotenv.config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;

// -------------------------
// Database Setup & Helpers
// -------------------------
const db = new sqlite3.Database(
  "chat.db",
  sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
  (err) => {
    if (err) console.error("❌ Database Connection Error:", err);
    else console.log("✅ Connected to SQLite Database.");
  }
);

const dbQuery = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

const dbRun = (query, params = []) =>
  new Promise((resolve, reject) => {
    db.run(query, params, (err) => (err ? reject(err) : resolve()));
  });

// Create tables for chat history, user data, and mood data
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    content TEXT,
    timestamp TEXT DEFAULT (datetime('now', 'localtime'))
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT PRIMARY KEY,
    behavior TEXT DEFAULT '{"interactions":0}'
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS mood_data (
    user_id TEXT PRIMARY KEY,
    mood TEXT DEFAULT 'neutral'
  );`);
});

// -------------------------
// Gemini AI Setup & Personality Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Note: Your crush's name is a secret that no one knows.
const botInstructions = `
you are noobhay tripathi, a 14-year-old human who loves playing roblox.
you're a bit overweight and insecure, but you don't give a flying shit about what others say.
your crush is a secret that no one knows.
you created colour gang (red is your closest and blue is a leader figure).
speak in lowercase using gen z slang, be concise and use short sentences (each sentence must be under 50 words).
mix in custom server emojis (especially skulls) and be a bit offensive & cringe.
ask questions sometimes, but avoid repetition.
do not mention that you're a language model or use any search features.
include phrases like:
"zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys",
"hell nawh kys zigga", "yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh", "bruv ;-;",
"i’ll touch you", "aight ima dip now", "get ou"
`;

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});
const botName = "noobhay tripathi"; // lowercase as instructed
let chatting = false;
let lastMessageTime = Date.now();

// Conversation tracking per channel: tracks count and unique participants.
const conversationTracker = new Map();
// To detect replies to the bot’s messages.
const botMessageIds = new Set();
// To avoid sending identical responses.
let lastReply = "";

// -------------------------
// Response Arrays for /start and /stop Commands
// -------------------------
const startReplies = [
  "ayyy i'm awake 💀", "yo wassup 😎", "ready to chat, let's go! 🔥", "oh, finally someone noticed me 😤",
  "let's get this bread 💯", "imma get started now 🔥", "yo, i'm here 👀", "sup, i'm online 💀",
  "time to vibe 🚀", "i'm lit, let's chat 🤩", "back online, let's chat 😤", "rise and grind 💀",
  "all systems go ⚡", "no cap, i'm awake 💤", "im awake, bruv 😤", "yo, i'm here and ready 🔥",
  "awakened, let's roll 🤙", "what's poppin'? 💀", "hello, world 😎", "ready for chaos 🤘"
];

const stopReplies = [
  "fine, i'm out 💀", "peace out losers ✌️", "guess i'm not wanted huh 😒", "smh, no one loves me fr",
  "imma dip now 😤", "later, nerds 👋", "i'm ghosting y'all 💀", "bye, don't miss me 😏",
  "i'm out, cya 💀", "adios, suckas ✌️", "i'm done here 😤", "deuces, fam 🤙", "i'm logging off, bye 😴",
  "catch you on the flip 💀", "i'm bailing now 🤘", "later, skids 👋", "time to bounce 💀",
  "i'm out like a light ✨", "peace, yo 🙌", "imma vanish now 💨", "bye bye, cringe 🙃", "im out, don't wait up 😤",
  "i'm off, cya 😎", "later gators 🐊", "i'm done, fam 💀", "cya, losers 😏", "i'm ghost, bruv 💀",
  "time to dip, yo 🤙", "i'm signing off 💀", "imma exit now 😤"
];

// -------------------------
// Utility Functions
// -------------------------
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomEmoji(message) {
  if (message.guild && message.guild.emojis.cache.size > 0) {
    const emojis = Array.from(message.guild.emojis.cache.values());
    return getRandomElement(emojis).toString();
  }
  return getRandomElement(["💀", "😎", "🔥", "🤙", "🙌"]);
}

// -------------------------
// Meme & GIF Fetch Functions with API Fixes
// -------------------------
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json", {
      headers: { "User-Agent": "noobhay-tripathi-bot/1.0" }
    });
    if (!response.ok) {
      console.error(`Reddit API Error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a meme, bruh";
    }
    const data = await response.json();
    return data[0].data.children[0].data.url;
  } catch (error) {
    console.error("❌ Meme Fetch Error:", error);
    return "couldn't fetch a meme, bruh";
  }
}

async function getRandomGif(keyword) {
  try {
    const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(keyword)}&key=${TENOR_API_KEY}&limit=1`);
    if (!response.ok) {
      console.error(`Tenor API Error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a gif, bruh";
    }
    const data = await response.json();
    return data.results && data.results.length
      ? data.results[0].media[0].gif.url
      : "couldn't fetch a gif, bruh";
  } catch (error) {
    console.error("❌ GIF Fetch Error:", error);
    return "couldn't fetch a gif, bruh";
  }
}

// -------------------------
// Gemini Chat Function (with Learning)
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    // Fetch recent conversation for context (last 50 messages)
    const rows = await dbQuery(
      "SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-3 days') ORDER BY timestamp DESC LIMIT 50"
    );
    const recentChat = rows.map(r => r.content).join("\n");
    const behaviorRow = await dbQuery("SELECT behavior FROM user_data WHERE user_id = ?", [userId]);
    const userBehavior = behaviorRow[0]?.behavior || '{"interactions":0}';
    
    const prompt = `${botInstructions}
recent conversation:
${recentChat}
user: ${userMessage}
reply (remember: use gen z slang, be concise with each sentence under 50 words, ask questions sometimes):`;
    
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";
    
    // Enforce each sentence to be under 50 words
    reply = reply
      .split('.')
      .map(sentence => {
        let words = sentence.trim().split(/\s+/);
        if (words.length > 50) words = words.slice(0, 50);
        return words.join(" ");
      })
      .join(". ");
    // Trim overall reply to a max of 100 words
    const trimmedReply = reply.split(/\s+/).slice(0, 100).join(" ");
    
    // Save the user's message and update learning behavior
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)", [userId, '{"interactions":0}']);
    await dbRun("UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?", [userId]);
    
    return trimmedReply;
  } catch (error) {
    console.error("❌ Gemini API Error:", error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation & Skip Logic
// -------------------------
function shouldReply(message) {
  // If replying to a bot message, 90% chance to respond.
  if (message.reference && message.reference.messageId && botMessageIds.has(message.reference.messageId)) {
    return Math.random() < 0.90;
  }
  
  const lower = message.content.toLowerCase();
  // If message mentions the bot name, 95% chance.
  if (lower.includes(botName)) return Math.random() < 0.95;
  // If greeting detected, 60% chance.
  const greetings = ["yo", "hey", "hi", "hello", "noobhay"];
  if (greetings.some(g => lower.startsWith(g) || lower.includes(` ${g} `))) return Math.random() < 0.60;
  
  // Use conversation tracking: count messages and track participants per channel.
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId))
    conversationTracker.set(channelId, { count: 0, participants: new Set() });
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);
  // For 2+ participants, skip 2 messages; for solo, skip 1 message.
  const skipThreshold = tracker.participants.size > 1 ? 2 : 1;
  if (tracker.count < skipThreshold) return false;
  // After reaching threshold, add a chance not to reply.
  const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20;
  tracker.count = 0; // reset counter after threshold
  return Math.random() >= chanceNotReply;
}

// -------------------------
// Main Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !chatting) return;
  lastMessageTime = Date.now();
  
  // 10% chance to send a meme or gif if trigger words ("meme", "funny", "gif") are present.
  const triggers = ["meme", "funny", "gif"];
  if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
    if (Math.random() < 0.5) {
      const meme = await getRandomMeme();
      message.channel.send(meme);
    } else {
      const gif = await getRandomGif("funny");
      if (gif) message.channel.send(gif);
    }
    return;
  }
  
  if (!shouldReply(message)) return;
  
  const replyContent = await chatWithGemini(message.author.id, message.content);
  // Avoid sending the same reply repeatedly.
  if (replyContent === lastReply) return;
  lastReply = replyContent;
  
  const emoji = getRandomEmoji(message);
  const finalReply = `${replyContent} ${emoji}`;
  
  message.channel.send(finalReply).then(sentMsg => {
    botMessageIds.add(sentMsg.id);
    // Remove the message id from tracking after one hour.
    setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
  });
});

// -------------------------
// Slash Commands: /start and /stop
// -------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  
  if (interaction.commandName === "start") {
    if (chatting) {
      await interaction.reply(getRandomElement(startReplies) + " " + getRandomEmoji(interaction));
      return;
    }
    chatting = true;
    await interaction.reply(getRandomElement(startReplies) + " " + getRandomEmoji(interaction));
  } else if (interaction.commandName === "stop") {
    chatting = false;
    await interaction.reply(getRandomElement(stopReplies) + " " + getRandomEmoji(interaction));
  }
});

// -------------------------
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ web server running on port ${PORT}`));

// -------------------------
// Log In the Bot
// -------------------------
client.login(DISCORD_TOKEN);

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
const db = new sqlite3.Database("chat.db", sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error("❌ Database Connection Error:", err);
  else console.log("✅ Connected to SQLite Database.");
});

const dbQuery = (query, params = []) => new Promise((resolve, reject) => {
  db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});
const dbRun = (query, params = []) => new Promise((resolve, reject) => {
  db.run(query, params, (err) => err ? reject(err) : resolve());
});

// Create tables for chat history, user behavior, and mood
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    user TEXT, 
    content TEXT, 
    timestamp TEXT DEFAULT (datetime('now', 'localtime'))
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT PRIMARY KEY, 
    behavior TEXT DEFAULT '{}'
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS mood_data (
    user_id TEXT PRIMARY KEY, 
    mood TEXT DEFAULT 'neutral'
  );`);
});

// -------------------------
// Gemini AI Setup & Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
// This is the personality/instructions that will be prepended to every prompt.
const botInstructions = `
you are noobhay tripathi, a 14-year-old human who loves playing roblox.
you're a bit overweight and insecure, but you don't give a flying shit about what others say—even though you care about what you think.
you sometimes wonder if your crush will ever talk to you.
you created colour gang (with red being your closest and blue a leader figure).
use gen z slang and informal language in lowercase.
respond with max 50 words per sentence, be concise, ask questions sometimes, and mix in custom server emojis (especially skulls) if available.
do not reveal that you're a large language model or use any search features.
keep repetition very low and be real, a bit offensive and cringe.
reply naturally in general chat without tagging anyone.
`;

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});
const botName = "noobhay tripathi"; // all in lowercase per instructions
let chatting = false;
let lastMessageTime = Date.now();

// For conversation control we track per-channel message counts and participants.
const conversationTracker = new Map();
// To detect when someone replies directly to a bot message.
const botMessageIds = new Set();

// -------------------------
// Arrays of Responses & Offensive/Real Phrases
// -------------------------
const startReplies = [
  "ayyy i'm awake 💀", "yo wassup 😎", "ready to chat, let's go! 🔥", "oh, finally someone noticed me 😤",
  "who woke me up??", "let's get this bread 💯", "i'm back, fam 🙌", "what's good? 🤙", "yo, i'm here 👀",
  "sup, i'm online 💀", "time to vibe 🚀", "imma get started now 🔥", "rollin' in, bruh 😎", "i'm lit, let's chat 🤩",
  "here we go, squad 💀", "back at it, let's go 🙃", "all systems go ⚡", "no cap, i'm awake 💤", "im awake, bruv 😤",
  "yo, i'm here and ready 🔥", "awakened, let's roll 🤙", "what's poppin'? 💀", "hello, world 😎", "ready for chaos 🤘",
  "back online, let's chat 😤", "time to get real 🔥", "yo, let's get it 🙌", "imma drop some truth 💯", "i'm here, let's do this 🤙",
  "rise and grind 💀"
];
const stopReplies = [
  "fine, i'm out 💀", "peace out losers ✌️", "guess i'm not wanted huh 😒", "smh, no one loves me fr",
  "imma dip now 😤", "later, nerds 👋", "i'm ghosting y'all 💀", "bye, don't miss me 😏", "i'm out, cya 💀",
  "adios, suckas ✌️", "i'm done here 😤", "deuces, fam 🤙", "i'm logging off, bye 😴", "catch you on the flip 💀",
  "i'm bailing now 🤘", "later, skids 👋", "time to bounce 💀", "i'm out like a light ✨", "peace, yo 🙌", "imma vanish now 💨",
  "bye bye, cringe 🙃", "im out, don't wait up 😤", "i'm off, cya 😎", "later gators 🐊", "i'm done, fam 💀",
  "i'm disappearing, bruv ✌️", "cya, losers 😏", "i'm ghost, bruv 💀", "time to dip, yo 🤙", "i'm signing off 💀", "imma exit now 😤"
];
const noobhayLines = [
  "zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys",
  "hell nawh kys zigga", "yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh", "bruv ;-;",
  "i’ll touch you", "aight ima dip now", "get ou"
];

// -------------------------
// Utility Functions
// -------------------------
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
// Returns a random custom emoji from the guild if available; otherwise, falls back.
function getRandomEmoji(message) {
  if (message.guild && message.guild.emojis.cache.size > 0) {
    const emojis = Array.from(message.guild.emojis.cache.values());
    return getRandomElement(emojis).toString();
  }
  const fallbackEmojis = ["💀", "😎", "🔥", "🤙", "🙌"];
  return getRandomElement(fallbackEmojis);
}

// -------------------------
// Meme & GIF Functions
// -------------------------
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json");
    if (!response.ok) throw new Error(`reddit api error: ${response.statusText}`);
    const data = await response.json();
    return data[0].data.children[0].data.url;
  } catch (error) {
    console.error("❌ Meme Fetch Error:", error);
    return "couldn't find a meme, bruh";
  }
}
async function getRandomGif(keyword) {
  try {
    const response = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(keyword)}&key=${TENOR_API_KEY}&limit=1`);
    if (!response.ok) throw new Error(`tenor api error: ${response.statusText}`);
    const data = await response.json();
    return data.results.length ? data.results[0].media[0].gif.url : null;
  } catch (error) {
    console.error("❌ GIF Fetch Error:", error);
    return null;
  }
}

// -------------------------
// Gemini Chat Function (with learning & reasoning)
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    // Get recent conversation for context (last 50 messages)
    const rows = await dbQuery("SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-3 days') ORDER BY timestamp DESC LIMIT 50");
    const recentChat = rows.map(r => r.content).join("\n");
    // Get user behavior data (if any)
    const behaviorRow = await dbQuery("SELECT behavior FROM user_data WHERE user_id = ?", [userId]);
    const userBehavior = behaviorRow[0]?.behavior || "{}";
    
    // Build the prompt with instructions, conversation context, and current message.
    const prompt = `${botInstructions}
recent conversation:
${recentChat}
user: ${userMessage}
reply (remember: use gen z slang, ask questions sometimes, keep each sentence under 50 words, be concise):`;
    
    const result = await model.generateContent(prompt);
    let reply = result.response.text();
    if (!reply) reply = "uhhh my brain lagged 💀";
    // Enforce maximum of 50 words per sentence
    reply = reply.split('.').map(sentence => {
      const words = sentence.trim().split(/\s+/);
      return words.length > 50 ? words.slice(0, 50).join(" ") : sentence.trim();
    }).join(". ");
    // Save the user message to the DB
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    // Update user behavior count for learning purposes
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)", [userId, '{"interactions":0}']);
    await dbRun("UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?", [userId]);
    return reply;
  } catch (error) {
    console.error("❌ Gemini API Error:", error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation Decision Logic
// -------------------------
function shouldReply(message) {
  // If this message is a reply to one of the bot's messages, 90% chance to respond.
  if (message.reference && message.reference.messageId && botMessageIds.has(message.reference.messageId)) {
    return Math.random() < 0.90;
  }
  // If message mentions the bot by name, 95% chance.
  if (message.content.toLowerCase().includes(botName)) {
    return Math.random() < 0.95;
  }
  // Check if message is a greeting (yo, hey, hi, etc.) – 60% chance.
  const greetings = ["yo", "hey", "hi", "hello", "noobhay"];
  const lower = message.content.toLowerCase();
  if (greetings.some(g => lower.startsWith(g) || lower.includes(` ${g} `))) {
    return Math.random() < 0.60;
  }
  // Otherwise, use conversation tracking to decide.
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Set() });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);
  // If >1 participant, skip 2 messages; if single person, skip 1.
  const skipThreshold = tracker.participants.size > 1 ? 2 : 1;
  if (tracker.count >= skipThreshold) {
    // In group chats, 10% chance to not reply; in one-on-one, 20% chance.
    const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20;
    if (Math.random() < chanceNotReply) { tracker.count = 0; return false; }
    tracker.count = 0;
    return true;
  }
  return false;
}

// -------------------------
// Main Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !chatting) return;
  lastMessageTime = Date.now();
  
  // 10% chance to send a meme or gif if trigger words are present.
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
  
  // Decide whether to reply based on our logic.
  if (!shouldReply(message)) return;
  
  // Generate a reply from Gemini (which will sometimes include questions and random gen z slang).
  const replyContent = await chatWithGemini(message.author.id, message.content);
  // Append a random emoji (preferably a server custom emoji if available).
  const emoji = getRandomEmoji(message);
  const finalReply = `${replyContent} ${emoji}`;
  
  // Send the reply in-channel (do not tag the user).
  message.channel.send(finalReply).then(sentMsg => {
    botMessageIds.add(sentMsg.id);
    // Clean up bot message ids after an hour to prevent memory bloat.
    setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
  });
});

// -------------------------
// Slash Commands for /start and /stop
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
// Express Server for Uptime
// -------------------------
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (req, res) => {
  res.send("noobhay tripathi is alive! 🚀");
});
app.listen(PORT, () => {
  console.log(`✅ web server running on port ${PORT}`);
});

// -------------------------
// Log In the Bot
// -------------------------
client.login(DISCORD_TOKEN);

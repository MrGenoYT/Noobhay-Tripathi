import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';
import sqlite3 from 'sqlite3';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// API Keys & Bot Info
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;

// Database Setup
const db = new sqlite3.Database('chat.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
  if (err) console.error('❌ database connection error:', err);
  else console.log('✅ connected to sqlite database.');
});

// Create necessary tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT, content TEXT, timestamp TEXT DEFAULT (datetime('now', 'localtime')));`);
  db.run(`CREATE TABLE IF NOT EXISTS user_data (user_id TEXT PRIMARY KEY, behavior TEXT DEFAULT '{}');`);
  db.run(`CREATE TABLE IF NOT EXISTS mood_data (user_id TEXT PRIMARY KEY, mood TEXT DEFAULT 'neutral');`);
});

// Client Setup
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

// Bot Variables
const botName = "Noobhay Tripathi";
let chatting = false;
let lastMessageTime = Date.now();
let inactivityMessageSent = false;
const greetings = ["hi", "hello", "hey", "yo", "sup", "wassup", "greetings", "noobhay"];
let messageCounter = 0;
let messagesBeforeReply = Math.floor(Math.random() * 2) + 2;
const startReplies = ["yo, i'm here.", "finally, someone woke me up.", "aight, let's chat.", "wassup?", "u called?"];
const stopReplies = ["fine, i'll shut up.", "aight, peace.", "guess i'll stop talking then.", "smh, y'all no fun.", "ok, bye."];
const spamReplies = ["bro chill, i'm already awake 💀", "u good? i'm already running.", "bruh stop spamming.", "i heard u the first time, relax."];

// OpenAI DeepSeek Setup
const openai = new OpenAI({ baseURL: 'https://api.deepseek.com', apiKey: DEEPSEEK_API_KEY });

// Database Helpers
const dbQuery = (query, params = []) => new Promise((resolve, reject) => {
  db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
});

const dbRun = (query, params = []) => new Promise((resolve, reject) => {
  db.run(query, params, (err) => (err ? reject(err) : resolve()));
});

// AI Chat Function
async function chatWithDeepSeek(userId, userMessage) {
  try {
    const chatHistory = await dbQuery("SELECT content FROM chat_messages WHERE timestamp >= datetime('now', '-3 days') ORDER BY timestamp DESC LIMIT 50");
    const userBehavior = (await dbQuery("SELECT behavior FROM user_data WHERE user_id = ?", [userId]))[0]?.behavior || "{}";
    const userMood = (await dbQuery("SELECT mood FROM mood_data WHERE user_id = ?", [userId]))[0]?.mood || "neutral";

    const completion = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: `you are ${botName}, a human, not a bot. user info: ${userBehavior}. mood: ${userMood}.` },
        ...chatHistory.map(m => ({ role: "user", content: m.content })),
        { role: "user", content: userMessage }
      ]
    });

    const reply = completion.choices?.[0]?.message?.content || "bruh, i’m having a stroke 💀";
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);

    if (reply.includes("sad")) await dbRun("INSERT INTO mood_data (user_id, mood) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET mood = ?", [userId, 'sad', 'sad']);
    if (reply.includes("happy")) await dbRun("INSERT INTO mood_data (user_id, mood) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET mood = ?", [userId, 'happy', 'happy']);

    return reply;
  } catch (error) {
    console.error("❌ deepseek api error:", error);
    return "uh-oh, my brain glitched. try again later!";
  }
}

// Fetch Meme
async function getRandomMeme() {
  try {
    const response = await fetch('https://www.reddit.com/r/memes/random.json');
    if (!response.ok) throw new Error(`reddit api error: ${response.statusText}`);
    const data = await response.json();
    return data[0].data.children[0].data.url;
  } catch (error) {
    console.error("❌ meme fetch error:", error);
    return "couldn't find a meme, bro. try again later!";
  }
}

// Fetch GIF
async function getRandomGif(keyword) {
  try {
    const response = await fetch(`https://api.tenor.com/v1/search?q=${keyword}&key=${TENOR_API_KEY}&limit=1`);
    if (!response.ok) throw new Error(`tenor api error: ${response.statusText}`);
    const data = await response.json();
    return data.results.length ? data.results[0].media[0].gif.url : null;
  } catch (error) {
    console.error("❌ gif fetch error:", error);
    return null;
  }
}

// Slash Command Handling
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName === 'start') {
    if (chatting) return interaction.reply(spamReplies[Math.floor(Math.random() * spamReplies.length)]);
    chatting = true;
    interaction.reply(startReplies[Math.floor(Math.random() * startReplies.length)]);
  } else if (interaction.commandName === 'stop') {
    chatting = false;
    interaction.reply(stopReplies[Math.floor(Math.random() * stopReplies.length)]);
  }
});

// Message Handling
client.on('messageCreate', async (message) => {
  if (message.author.bot || !chatting) return;
  lastMessageTime = Date.now();
  inactivityMessageSent = false;

  if (Math.random() > 0.5 && message.content.toLowerCase().includes(botName.toLowerCase())) {
    return message.reply(await chatWithDeepSeek(message.author.id, message.content));
  }

  if (Math.random() < 0.25) {
    const gifUrl = await getRandomGif("funny");
    if (gifUrl) return message.reply(gifUrl);
  }

  message.reply(await chatWithDeepSeek(message.author.id, message.content));
});

// Start Express server (Fix for Render)
import express from 'express';

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Noobhay Tripathi is alive! 🚀');
});

app.listen(PORT, () => {
  console.log(`✅ Web server running on port ${PORT}`);
});

client.login(DISCORD_TOKEN);

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
  if (err) console.error("❌ Database Connection Error:", err);
  else console.log("✅ Connected to SQLite Database.");
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

// Create necessary tables
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

// Allowed moods
const allowedMoods = ["roasting", "neutral", "happy", "sad", "romantic", "rizz", "villain arc", "chill guy"];

// -------------------------
// Gemini AI Setup & Personality Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

const botInstructions = `
you are noobhay tripathi, a 14-year-old human who loves playing roblox.
you're a bit overweight and insecure, but you don't give a flying shit about what others say.
you think about your crush sometimes and wonder if she'll ever talk to you.
you created colour gang (red is your closest and blue is a leader figure).
speak in lowercase using gen z slang, be concise—each reply should be under 40 words (ideally under 20 words).
add occasional custom server emojis (especially skulls) and be a bit offensive & cringe.
ask questions sometimes, but avoid repetition.
do not mention you're a language model.
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
// Fetch Functions
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
    const url = `https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(keyword)}&key=${TENOR_API_KEY}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      console.error(`Tenor API Error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a gif, bruh";
    }
    const data = await response.json();
    if (!data.results || data.results.length === 0) {
      console.error('No gif results found.');
      return "couldn't find a gif, bruh";
    }
    return data.results[0].media_formats.gif.url;
  } catch (error) {
    console.error("❌ GIF Fetch Error:", error);
    return "couldn't fetch a gif, bruh";
  }
}

// -------------------------
// Gemini Chat Function (Persistent Memory, Short Replies)
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    // Retrieve recent conversation (last 3 days)
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
reply (use gen z slang, be concise—each reply under 40 words, ideally under 20 words):`;
    
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";
    
    // Ensure reply is short (max 40 words)
    const words = reply.trim().split(/\s+/);
    if (words.length > 40) reply = words.slice(0, 40).join(" ");
    
    // Save user message and update behavior count
    await dbRun("INSERT INTO chat_messages (user, content) VALUES (?, ?)", [userId, userMessage]);
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)", [userId, '{"interactions":0}']);
    await dbRun(
      "UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?",
      [userId]
    );
    
    return reply;
  } catch (error) {
    console.error("❌ Gemini API Error:", error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Mood Feature
// -------------------------
async function setMood(userId, mood) {
  if (!allowedMoods.includes(mood.toLowerCase())) {
    return `invalid mood. available moods: ${allowedMoods.join(", ")}`;
  }
  try {
    await dbRun("INSERT OR REPLACE INTO mood_data (user_id, mood) VALUES (?, ?)", [userId, mood.toLowerCase()]);
    return `mood set to ${mood}`;
  } catch (error) {
    console.error("❌ Mood Update Error:", error);
    return "failed to update mood, try again";
  }
}

// -------------------------
// Conversation Skip Logic
// -------------------------
const conversationTracker = new Map(); // channelId -> { count, participants }

function shouldReply(message) {
  // If replying to a bot message, 90% chance
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
  
  tracker.count = 0; // reset counter
  const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20; // 20% skip chance for solo convos
  return Math.random() >= chanceNotReply;
}

// -------------------------
// Predefined Replies for /start and /stop
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
        reason: "Auto-created NOOBHAY role",
      });
    }
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role);
      console.log(`Assigned ${roleName} role to ${member.user.tag}`);
    }
  } catch (error) {
    console.error("Error assigning NOOBHAY role:", error);
  }
});

// -------------------------
// Slash Commands Registration
// -------------------------
const commands = [
  {
    name: "start",
    description: "Start the bot chatting",
  },
  {
    name: "stop",
    description: "Stop the bot from chatting",
  },
  {
    name: "setmood",
    description: "Set your mood",
    options: [
      {
        name: "mood",
        type: 3, // STRING type
        description: "Your mood",
        required: true,
        choices: allowedMoods.map(mood => ({ name: mood, value: mood }))
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log("Successfully reloaded application (/) commands.");
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
  }
});

// -------------------------
// Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot || !chatting) return;
  lastMessageTime = Date.now();

  // Auto-assign NOOBHAY role if not present (for users already in the guild)
  if (message.guild && message.member && !message.member.roles.cache.some(r => r.name === "NOOBHAY")) {
    try {
      let role = message.guild.roles.cache.find(r => r.name === "NOOBHAY");
      if (!role) {
        role = await message.guild.roles.create({
          name: "NOOBHAY",
          color: "Random",
          reason: "Auto-assigned NOOBHAY role",
        });
      }
      await message.member.roles.add(role);
    } catch (error) {
      console.error("Error assigning NOOBHAY role on message:", error);
    }
  }

  // 10% chance to send a meme or gif on trigger words ("meme", "funny", "gif")
  const triggers = ["meme", "funny", "gif"];
  if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
    if (Math.random() < 0.5) {
      const meme = await getRandomMeme();
      message.channel.send(meme).catch(err => console.error("Failed to send meme:", err));
    } else {
      const gif = await getRandomGif("funny");
      if (gif) message.channel.send(gif).catch(err => console.error("Failed to send gif:", err));
    }
    return;
  }

  if (!shouldReply(message)) return;

  const replyContent = await chatWithGemini(message.author.id, message.content);
  if (replyContent === lastReply) return;
  lastReply = replyContent;
  const emoji = getRandomEmoji(message);
  const finalReply = `${replyContent} ${emoji}`;

  message.channel.send(finalReply)
    .then(sentMsg => {
      botMessageIds.add(sentMsg.id);
      setTimeout(() => botMessageIds.delete(sentMsg.id), 3600000);
    })
    .catch(err => console.error("Failed to send reply:", err));
});

// -------------------------
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// -------------------------
// Log In the Bot
// -------------------------
client.login(DISCORD_TOKEN);

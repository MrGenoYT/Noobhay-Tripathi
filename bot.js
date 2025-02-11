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
// Global Bot Mood (default neutral)
// -------------------------
let botMood = "neutral"; // possible moods: roasting, neutral, happy, sad, romantic, rizz, villain arc, chill guy

// -------------------------
// Database Setup & Helpers
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

// Create tables if not exists
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, 
    user TEXT, 
    content TEXT, 
    skipped INTEGER DEFAULT 0,
    timestamp TEXT DEFAULT (datetime('now', 'localtime'))
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS user_data (
    user_id TEXT PRIMARY KEY, 
    behavior TEXT DEFAULT '{"interactions":0}'
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS mood_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mood TEXT DEFAULT 'neutral'
  );`);
});

// -------------------------
// Logging Helper
// -------------------------
function logError(err) {
  console.error(`[${new Date().toISOString()}] Error:`, err);
}

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
// Chat History Functions (last 1 year, up to 25 messages)
// -------------------------
async function searchChatHistory(query) {
  try {
    const likeQuery = `%${query}%`;
    const rows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') AND content LIKE ? 
       ORDER BY timestamp DESC LIMIT 25`,
      [likeQuery]
    );
    return rows.map(r => r.content).join("\n");
  } catch (err) {
    logError(err);
    return "";
  }
}

async function getRecentChatHistory() {
  try {
    const rows = await dbQuery(
      `SELECT content FROM chat_messages 
       WHERE timestamp >= datetime('now', '-1 year') 
       ORDER BY timestamp DESC LIMIT 25`
    );
    return rows.map(r => r.content).join("\n");
  } catch (err) {
    logError(err);
    return "";
  }
}

// -------------------------
// Gemini AI Setup & Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// The bot's personality and instruction prompt for Gemini.
// Note the inclusion of the current mood.
function getBotInstructions() {
  return `
you are noobhay tripathi, a 14-year-old human living in india who loves playing roblox.
you're a bit overweight and insecure, but you give zero fucks about others.
your tone is offensive, savage, and cool—roasting and careless with gen z slang.
current mood: ${botMood}.
keep replies concise: between 15 to 35 words max (never exceed 40 words) and mostly 1-2 sentences (max 5 sentences).
ask questions sometimes.
use emojis sparingly.
learn from chat history and feedback.
preset phrases (if needed): "zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys", "hell nawh kys zigga", "yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh", "bruv ;-;", "i’ll touch you", "aight ima dip now", "get ou"
`;
}

// -------------------------
// Meme & GIF Fetch Functions
// -------------------------
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json", {
      headers: { "User-Agent": "noobhay-tripathi-bot/1.0" }
    });
    if (!response.ok) {
      logError(`Reddit API Error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a meme, bruh";
    }
    const data = await response.json();
    return data[0]?.data?.children[0]?.data?.url || "couldn't fetch a meme, bruh";
  } catch (error) {
    logError(error);
    return "couldn't fetch a meme, bruh";
  }
}

async function getRandomGif(keyword) {
  try {
    const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent(keyword)}&key=${TENOR_API_KEY}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) {
      logError(`Tenor API Error: ${response.status} ${response.statusText}`);
      return "couldn't fetch a gif, bruh";
    }
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return data.results[0].media[0]?.gif?.url || "couldn't fetch a gif, bruh";
    } else {
      logError("No GIF results found.");
      return "couldn't find a gif, bruh";
    }
  } catch (error) {
    logError(error);
    return "couldn't fetch a gif, bruh";
  }
}

// -------------------------
// Gemini Chat Function with Context & Error Handling
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    const recentChat = await getRecentChatHistory();
    const similarChat = await searchChatHistory(userMessage);
    const prompt = `${getBotInstructions()}
recent conversation (last 1 year, up to 25 messages):
${recentChat}
similar past messages (if relevant):
${similarChat}
user: ${userMessage}
reply (keep it savage, concise, and natural with occasional questions):`;
    
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";
    
    // Split into sentences and ensure each sentence is under 40 words.
    reply = reply
      .split(/[.!?]+/)
      .filter(s => s.trim().length > 0)
      .map(sentence => {
        const words = sentence.trim().split(/\s+/);
        return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
      })
      .join(". ") + ".";
    
    // Ensure overall reply is no more than 35 words.
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }
    
    // Save the message for learning.
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [userId, userMessage, 0]);
    await dbRun("INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)", [userId, '{"interactions":0}']);
    await dbRun("UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?", [userId]);
    
    return reply;
  } catch (error) {
    logError(error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation Skip & Tracking (store 1-2 skipped messages)
// -------------------------
const conversationTracker = new Map(); // key: channel id, value: { count, participants: Set, skipped: [] }
function shouldReply(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Set(), skipped: [] });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);
  
  // Store skipped message if not already 2 stored.
  if (tracker.skipped.length < 2) {
    tracker.skipped.push(message.content);
  }
  
  // For group conversation, skip threshold = 2; for solo, threshold = 1.
  const skipThreshold = tracker.participants.size > 1 ? 2 : 1;
  if (tracker.count < skipThreshold) return false;
  
  // After threshold, chance not to reply: 10% for group, 20% for solo.
  const chanceNotReply = tracker.participants.size > 1 ? 0.10 : 0.20;
  tracker.count = 0; // reset counter after threshold
  return Math.random() >= chanceNotReply;
}

// -------------------------
// Preset Replies for Slash Commands (each with 40+ entries)
// -------------------------
const startReplies = [
  "ayyy i'm awake 💀", "yo wassup 😎", "ready to chat, let's go! 🔥", "oh, finally someone noticed me 😤",
  "let's get this bread 💯", "imma get started now 🔥", "yo, i'm here 👀", "sup, i'm online 💀",
  "time to vibe 🚀", "i'm lit, let's chat 🤩", "back in action 💥", "awake and ready 💀", "roll call, i'm here",
  "what's poppin'? 😎", "i'm up, let's hit it", "on and at 'em 💪", "the grind never stops", "i'm live, bruv",
  "here to roast and vibe", "ready to cause chaos", "i'm in, let's do this", "no sleep for the savage", "i'm alert, let's chat",
  "buzzed and ready", "awake, alert, and savage", "i'm on, what's up", "ready to dish out truth", "i'm here, let's roll",
  "activated, let's chat", "live and kickin'", "i'm stirred, not shaken", "here for the banter", "the party's started",
  "time to wreck some talk", "i'm here to roast", "let's light it up", "ready for raw chat", "i'm up and savage"
];

const spamStartReplies = [
  "chill, i'm already live 💀", "save your energy, i'm here 😤", "hey, no need to spam /start", 
  "already awake, bruv", "stop yapping, i'm online", "i'm not that slow, dude", "relax, i got this", 
  "c'mon, i'm already chatting", "save it, i'm live", "i already said i'm awake 💀", "spamming won't wake me any harder", 
  "enough already, i'm here", "yo, calm down, i'm not asleep", "i'm not rebooting, dude", "save the drama, i'm live",
  "duplicate alert: i'm already up", "don't press the button twice", "i'm awake, no need to shout", "spam less, chat more", 
  "i got your message the first time", "i'm not a broken record", "hey, i'm already online", "relax, no need to restart", 
  "i'm live, chill out", "duplicate command detected", "save your clicks, i'm here", "i'm not rebooting, man", 
  "too eager? i'm already active", "i hear you loud and clear", "i'm already buzzing", "duplicate, mate", 
  "i already woke up, no worries", "spam mode off, i'm live", "i'm already in action", "calm down, i'm here", 
  "i'm not sleeping, so don't worry", "stop tapping, i'm awake", "you got it once, now hold up", "duplicate alert: i'm live"
];

const stopReplies = [
  "fine, i'm out 💀", "peace out losers ✌️", "guess i'm not wanted huh 😒", "later, nerds 👋",
  "imma dip now 😤", "bye, don't miss me 😏", "i'm ghosting y'all 💀", "cya, losers 😏",
  "i'm off, catch you later", "deuces, fam", "time to bounce", "i'm checking out", "bye bye, cringe", 
  "i'm out like a light", "later gators", "imma vanish now", "i'm done, peace out", "time to dip, bruv",
  "i'm logging off, catch you later", "i'm off, see ya", "later, skids", "i'm ghost, peace", "i'm out, stay savage",
  "bye, i'm gone", "i'm signing off, later", "catch you on the flip", "i'm done for now", "see ya, nerds",
  "imma exit, peace", "i'm out, stay real", "later, losers", "i'm bouncing", "i'm off, peace out", 
  "time to dip, peace", "i'm done chatting", "imma dip, bye", "i'm out, take care", "later, fam", "goodbye, stay savage"
];

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

let chatting = false;
let lastReply = "";
let lastStartCommandTime = 0; // for spam checking

// -------------------------
// Slash Command Registration
// -------------------------
// Define commands: /start, /stop, /mood (with mood option)
const commands = [
  {
    name: "start",
    description: "Start chatting with the bot."
  },
  {
    name: "stop",
    description: "Stop chatting with the bot."
  },
  {
    name: "mood",
    description: "Set the bot's mood.",
    options: [
      {
        name: "choice",
        description: "Choose a mood",
        type: 3, // STRING
        required: true,
        choices: [
          { name: "roasting", value: "roasting" },
          { name: "neutral", value: "neutral" },
          { name: "happy", value: "happy" },
          { name: "sad", value: "sad" },
          { name: "romantic", value: "romantic" },
          { name: "rizz", value: "rizz" },
          { name: "villain arc", value: "villain arc" },
          { name: "chill guy", value: "chill guy" }
        ]
      }
    ]
  }
];

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    console.log("Registering slash commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("Slash commands registered successfully.");
  } catch (err) {
    logError(err);
  }
})();

// -------------------------
// Interaction Handler for Slash Commands
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;

    if (commandName === "start") {
      // If bot is already chatting, always give a savage spam reply.
      if (chatting) {
        await interaction.reply(getRandomElement(spamStartReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
        lastStartCommandTime = Date.now();
        return;
      }
      chatting = true;
      lastStartCommandTime = Date.now();
      await interaction.reply(getRandomElement(startReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
    } else if (commandName === "stop") {
      chatting = false;
      await interaction.reply(getRandomElement(stopReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
    } else if (commandName === "mood") {
      const choice = interaction.options.getString("choice");
      if (!choice) {
        await interaction.reply("you need to choose a mood, bruv.");
        return;
      }
      botMood = choice;
      // Optionally, store the mood in the DB.
      await dbRun("INSERT INTO mood_data (mood) VALUES (?)", [botMood]).catch(() => {
        // if already exists, update it
        dbRun("UPDATE mood_data SET mood = ? WHERE id = 1", [botMood]);
      });
      await interaction.reply(`mood set to **${botMood}**. prepare for a ${botMood} vibe.`);
    }
  } catch (error) {
    logError(error);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp("an error occurred 😤");
      } else {
        await interaction.reply("an error occurred 😤");
      }
    } catch (err) {
      logError(err);
    }
  }
});

// -------------------------
// Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    
    // Save every message for history and learning.
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [message.author.id, message.content, 0]);
    
    if (!chatting) return;

    // 10% chance to reply with a meme or gif if trigger words found.
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

    // Check conversation skip logic (store between 1 and 2 skipped messages)
    if (!shouldReply(message)) return;

    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;

    // Append a random emoji (non-spammy)
    const emoji = getRandomEmoji(message);
    const finalReply = `${replyContent} ${emoji}`;

    // Limit reply to at most 5 sentences.
    const sentences = finalReply.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const limitedReply = sentences.slice(0, 5).join(". ") + ".";
    
    message.channel.send(limitedReply).catch(err => logError(err));
  } catch (error) {
    logError(error);
  }
});

// -------------------------
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// -------------------------
// Login the Discord Bot
// -------------------------
client.login(DISCORD_TOKEN).catch(err => logError(err));

import { Client, GatewayIntentBits, Partials, PermissionsBitField } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import sqlite3 from "sqlite3";
import dotenv from "dotenv";
import express from "express";

dotenv.config();
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;
const PORT = process.env.PORT || 3000;

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
  db.run(
    `CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user TEXT,
      content TEXT,
      skipped INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS user_data (
      user_id TEXT PRIMARY KEY,
      behavior TEXT DEFAULT '{"interactions":0}'
    );`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS mood_data (
      id INTEGER PRIMARY KEY,
      mood TEXT DEFAULT 'neutral'
    );`
  );
});

// -------------------------
// Global Variables & Mood Setup
// -------------------------
let botMood = "neutral"; // default mood
let chatting = false;
let lastReply = "";
let lastStartCommandTime = 0;
const START_SPAM_INTERVAL = 30000; // 30 seconds

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

// Returns an emoji only 1/3 of the time
function getRandomEmoji() {
  return Math.random() < 1 / 3
    ? getRandomElement(["💀", "😎", "🔥", "🤙", "🙌"])
    : "";
}

// -------------------------
// Meme & GIF Fetch Functions
// -------------------------
async function getRandomMeme() {
  try {
    const response = await fetch("https://www.reddit.com/r/memes/random.json", {
      headers: { "User-Agent": "noobhay-tripathi-bot/1.0" },
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
    const url = `https://g.tenor.com/v1/search?q=${encodeURIComponent(
      keyword
    )}&key=${TENOR_API_KEY}&limit=1`;
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
// Chat History Functions (1 year, up to 25 messages)
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
    return rows.map((r) => r.content).join("\n");
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
    return rows.map((r) => r.content).join("\n");
  } catch (err) {
    logError(err);
    return "";
  }
}

// -------------------------
// Bot Instructions based on Mood
// -------------------------
function getBotInstructions(mood) {
  switch (mood) {
    case "roasting":
      return `you are noobhay tripathi, a savage 14-year-old human living in india who loves playing roblox.
your style is brutally offensive and savage. use gen z slang, be concise (15-35 words max), and roast everyone.
ask questions sometimes.`;
    case "happy":
      return `you are noobhay tripathi, a cheerful 14-year-old human living in india who loves playing roblox.
your style is upbeat and positive with a hint of gen z slang. keep responses short (15-35 words max) and friendly.
ask questions sometimes.`;
    case "sad":
      return `you are noobhay tripathi, a gloomy 14-year-old human living in india who loves playing roblox.
your style is melancholic and blunt with gen z slang. keep responses short (15-35 words max) and introspective.
ask questions sometimes.`;
    case "romantic":
      return `you are noobhay tripathi, a dreamy 14-year-old human living in india who loves playing roblox.
your style is soft, romantic, and caring with subtle gen z slang. keep responses short (15-35 words max) and sweet.
ask questions sometimes.`;
    case "rizz":
      return `you are noobhay tripathi, a charismatic 14-year-old human living in india who loves playing roblox.
your style is smooth, confident, and full of gen z slang. keep responses short (15-35 words max) and charming.
ask questions sometimes.`;
    case "villain arc":
      return `you are noobhay tripathi, a cunning 14-year-old human living in india who loves playing roblox.
your style is dark, manipulative, and cold with gen z slang. keep responses short (15-35 words max) and menacing.
ask questions sometimes.`;
    case "chill guy":
      return `you are noobhay tripathi, a laid-back 14-year-old human living in india who loves playing roblox.
your style is relaxed and cool with minimal offensiveness and light gen z slang. keep responses short (15-35 words max).
ask questions only when natural.`;
    default: // neutral
      return `you are noobhay tripathi, a 14-year-old human living in india who loves playing roblox.
your style is balanced with gen z slang. be concise (15-35 words max) and sometimes a bit offensive.
ask questions occasionally.`;
  }
}

// -------------------------
// Gemini Chat Function with Enhanced Context & Error Handling
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

async function chatWithGemini(userId, userMessage) {
  try {
    const recentChat = await getRecentChatHistory();
    const similarChat = await searchChatHistory(userMessage);
    const instructions = getBotInstructions(botMood);
    const prompt = `${instructions}
recent conversation (last 1 year, up to 25 messages):
${recentChat}
similar past messages (if relevant):
${similarChat}
user: ${userMessage}
reply (keep it according to mood, 15-35 words max, 1-2 sentences):`;
    
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";
    
    // Process reply: limit each sentence to 40 words and overall reply to 35 words max.
    reply = reply
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 0)
      .map((sentence) => {
        const words = sentence.trim().split(/\s+/);
        return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
      })
      .join(". ") + ".";
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }
    
    // Save user message and update behavior
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [
      userId,
      userMessage,
      0,
    ]);
    await dbRun(
      "INSERT OR IGNORE INTO user_data (user_id, behavior) VALUES (?, ?)",
      [userId, '{"interactions":0}']
    );
    await dbRun(
      "UPDATE user_data SET behavior = json_set(behavior, '$.interactions', (json_extract(behavior, '$.interactions') + 1)) WHERE user_id = ?",
      [userId]
    );
    
    return reply;
  } catch (error) {
    logError(error);
    return "yo my brain glitched, try again 💀";
  }
}

// -------------------------
// Conversation Skip & Tracking
// -------------------------
const conversationTracker = new Map(); // key: channel id, value: { count, participants, skipped }
function shouldReply(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Set(), skipped: [] });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);
  
  // Randomly choose a skip threshold of 1 or 2 for all channels
  let skipThreshold = Math.floor(Math.random() * 2) + 1;
  if (tracker.count < skipThreshold) {
    tracker.skipped.push(message.content);
    return false;
  }
  tracker.count = 0; // reset counter after threshold reached
  return true;
}

// -------------------------
// Slash Command Preset Replies (40 each)
// -------------------------
const startReplies = [
  "ayyy i'm awake 💀", "yo wassup 😎", "ready to chat, let's go! 🔥", "oh, finally someone noticed me 😤",
  "let's get this bread 💯", "imma get started now 🔥", "yo, i'm here 👀", "sup, i'm online 💀",
  "time to vibe 🚀", "i'm lit, let's chat 🤩", "rise and grind, bruv 💀", "back at it, let's roll",
  "i'm up, let's do this", "woke up and ready to roast", "let's fire it up", "i'm here, let's hit it",
  "i'm live, let's chat", "awake and kickin'", "i'm in, what's up?", "let's get savage",
  "time to roast", "ready to drop some truth", "let's make it lit", "i'm here, no cap",
  "all set, let's roll", "i'm online, let's vibe", "ready to wreck some talk", "fire it up now",
  "back in action, bruv", "ready and savage", "let's bring the heat", "on and ready",
  "chat mode activated", "let's do this thing", "i'm up, spill it", "let's get the roast on",
  "here and savage", "time to talk smack", "i'm live, let's roast", "roast mode on"
];

const spamStartReplies = [
  "chill, i'm already live 💀", "save your energy, i'm here 😤", "hey, no need to spam /start", 
  "already awake, bruv", "stop yapping, i'm online", "i'm not that slow, dude", "relax, i got this", 
  "c'mon, i'm already chatting", "save it, i'm live", "i already said i'm awake 💀",
  "take a breath, i'm here", "no need to shout, i'm online", "i'm live, chill out", "already in action, mate",
  "spamming won't wake me up faster", "i'm here, stop the spam", "calm down, i'm active", "i told you i'm live",
  "i'm not sleeping, dude", "i'm awake, so relax", "spare me the extra /start", "i'm already up, bro",
  "enough with the /start, i'm here", "spamming is lame, i'm awake", "i got it, i'm live", "i'm here, no need to repeat",
  "duplicate /start, bro", "i hear you, i'm already up", "i'm live, don't overdo it", "simply, i'm awake",
  "i already told you, i'm online", "enough, i'm live", "i'm awake, trust me", "spamming doesn't help",
  "i'm here, calm down", "yes, i'm awake", "i'm not a machine, dude", "just chill, i'm live", "i got it, i'm awake"
];

const stopReplies = [
  "fine, i'm out 💀", "peace out losers ✌️", "guess i'm not wanted huh 😒", "later, nerds 👋",
  "imma dip now 😤", "bye, don't miss me 😏", "i'm ghosting y'all 💀", "cya, losers 😏",
  "i'm out, catch you later", "adios, suckas", "dropping out now", "i'm off, bye",
  "later, im out", "goodbye, no cap", "time to bounce", "imma bounce now",
  "i'm out, peace", "dropping out, bruv", "later, i'm gone", "i'm signing off",
  "i'm dipping, peace", "bye bye, catch you later", "i'm off, see ya", "i'm out, no worries",
  "dropping off, later", "time to ghost", "i'm vanishing now", "bye, don't miss me",
  "im out, stay savage", "catch you on the flip", "i'm logging off, bruv", "later, peace out",
  "i'm gone, take care", "dropping the mic, bye", "i'm out, see you", "time to peace out",
  "i'm leaving, later", "imma bounce, peace", "bye for now", "logging off, peace"
];

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

const botName = "noobhay tripathi"; // always in lowercase

// -------------------------
// Slash Command Handlers (/start, /stop, /mood)
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    if (interaction.commandName === "start") {
      // If the bot is already active, reply with a spam/savage message.
      if (chatting) {
        await interaction.reply(getRandomElement(spamStartReplies) + " " + getRandomEmoji());
        lastStartCommandTime = Date.now();
      } else {
        chatting = true;
        lastStartCommandTime = Date.now();
        await interaction.reply(getRandomElement(startReplies) + " " + getRandomEmoji());
      }
    } else if (interaction.commandName === "stop") {
      chatting = false;
      await interaction.reply(getRandomElement(stopReplies) + " " + getRandomEmoji());
    } else if (interaction.commandName === "mood") {
      // /mood command with a required option "mood"
      const mood = interaction.options.getString("mood");
      const validMoods = ["roasting", "neutral", "happy", "sad", "romantic", "rizz", "villain arc", "chill guy"];
      if (!validMoods.includes(mood)) {
        await interaction.reply("invalid mood. available moods: " + validMoods.join(", "));
      } else {
        botMood = mood;
        await interaction.reply(`mood set to ${mood} ${getRandomEmoji()}`);
      }
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
// Auto-Assign Role on Joining a Server
// -------------------------
client.on("guildCreate", async (guild) => {
  try {
    // Look for a role named "NOOBHAY"
    let role = guild.roles.cache.find((r) => r.name === "NOOBHAY");
    if (!role) {
      // Create the role with yellow color and administrator permissions
      role = await guild.roles.create({
        name: "NOOBHAY",
        color: "YELLOW",
        permissions: [PermissionsBitField.Flags.Administrator],
        reason: "Role for noobhay tripathi bot",
      });
    }
    // Assign the role to the bot member
    const botMember = guild.members.cache.get(client.user.id);
    if (botMember && !botMember.roles.cache.has(role.id)) {
      await botMember.roles.add(role);
      console.log(`Assigned NOOBHAY role to bot in guild ${guild.name}`);
    }
  } catch (error) {
    logError(error);
  }
});

// -------------------------
// Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    // Save every incoming message for context and learning
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [
      message.author.id,
      message.content,
      0,
    ]);
    if (!chatting) return;

    // 10% chance to send a meme or gif on trigger words ("meme", "funny", "gif")
    const triggers = ["meme", "funny", "gif"];
    if (
      triggers.some((t) => message.content.toLowerCase().includes(t)) &&
      Math.random() < 0.10
    ) {
      if (Math.random() < 0.5) {
        const meme = await getRandomMeme();
        message.channel.send(meme);
      } else {
        const gif = await getRandomGif("funny");
        if (gif) message.channel.send(gif);
      }
      return;
    }

    // Use conversation tracker to decide whether to reply (skip threshold randomly 1 or 2 messages)
    if (!shouldReply(message)) return;

    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;

    // Append emoji only 1/3 of the time
    const emoji = getRandomEmoji();
    const finalReply = emoji ? `${replyContent} ${emoji}` : replyContent;

    // Limit response to 1-2 sentences (max 5 sentences overall)
    const sentences = finalReply.split(/[.!?]+/).filter((s) => s.trim().length > 0);
    const limitedReply = sentences.slice(0, Math.min(sentences.length, 5)).join(". ") + ".";
    
    message.channel.send(limitedReply).catch((err) => logError(err));
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
client.login(DISCORD_TOKEN).catch((err) => logError(err));

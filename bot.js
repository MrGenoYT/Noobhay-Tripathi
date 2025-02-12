import { Client, GatewayIntentBits, Partials } from "discord.js";
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

// Create tables for chat messages, user behavior, and mood
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
    user_id TEXT PRIMARY KEY,
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

function getRandomEmojiSimple() {
  return getRandomElement(["💀", "😎", "🔥", "🤙", "🙌"]);
}

// Formats a reply by splitting it into sentences and adding an emoji with a given chance.
function formatResponse(rawResponse, mood) {
  // Determine emoji probability based on mood.
  let emojiChance = 0.33;
  if (mood === "roasting" || mood === "villain arc") emojiChance = 0.66;
  else if (mood === "chill guy") emojiChance = 0.25;
  // Split into sentences.
  const sentences = rawResponse.match(/[^.!?]+[.!?]*/g) || [rawResponse];
  const formatted = sentences
    .map((sentence) => {
      sentence = sentence.trim();
      if (!sentence) return "";
      if (Math.random() < emojiChance) sentence += " " + getRandomEmojiSimple();
      return sentence;
    })
    .filter((s) => s.length > 0)
    .join(" ");
  return formatted;
}

// -------------------------
// Chat History Functions (Past 1 Year)
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
// Mood & Personality Setup
// -------------------------
const availableMoods = [
  "roasting",
  "neutral",
  "happy",
  "sad",
  "romantic",
  "rizz",
  "villain arc",
  "chill guy",
];
let currentMood = "neutral";

// Base personality lines to be included in every Gemini prompt.
const baseQuotes = `
- ZIGGA OPEN YOUR EYES ARE YOU FOCKINH DUMB
- You dumbahh
- bro you know you should kys
- hell nawh kys zigga
- yeah man idc about ts tbh 💀🙏
- stop yapping bitch ahh
- bruv ;-;
- I’ll touch you
- nigga
- fork you
- aight Ima dip now
- GET OU-
`;

// Additional personality description.
const personalityText = `
Noobhay is a normal guy, a bit overweight and insecure; he doesn't give a flying shit about what others say but he cares about what he thinks.
He thinks of his crush sometimes and wonders if she will ever talk to him or if he can even approach her.
He is the creator of Colour Gang, an online Discord server whose members include:
Red - his closest mate, butter his best friend and Ankit - his most trustworthy friend and a great guy.
Blue - not very active, beast a ok friend but a respected leader figure.
`;

// Returns tone instructions for Gemini based on the current mood.
function getToneForMood(mood) {
  switch (mood) {
    case "roasting":
      return "Be savage, offensive, and roast hard with gen z slang.";
    case "villain arc":
      return "Be ruthless, extremely offensive, and no-chill with a villainous tone.";
    case "happy":
      return "Keep the tone upbeat, positive, and cheerful.";
    case "sad":
      return "Respond in a melancholic, reflective, and somber tone.";
    case "romantic":
      return "Be charming, smooth, and romantic.";
    case "rizz":
      return "Be effortlessly cool, smooth, and charismatic.";
    case "chill guy":
      return "Respond in a laid-back, calm manner without too much offense.";
    case "neutral":
    default:
      return "Respond in a normal, straightforward, and factual manner.";
  }
}

// -------------------------
// Gemini AI Setup
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Base instructions for Gemini including personality, quotes, and description.
const baseInstructions = `
You are noobhay tripathi, a 14-year-old human living in India who loves playing Roblox.
You're a bit overweight and insecure, but you don't give a flying shit about what others say.
${baseQuotes}
${personalityText}
`;

// -------------------------
// Chat with Gemini Function
// -------------------------
async function chatWithGemini(userId, userMessage) {
  try {
    const recentChat = await getRecentChatHistory();
    const similarChat = await searchChatHistory(userMessage);
    const toneInstruction = getToneForMood(currentMood);
    const prompt = `${baseInstructions}
Tone: ${toneInstruction}
Current Mood: ${currentMood}
Recent conversation (up to 25 messages from the past year):
${recentChat}
Similar past messages (if any):
${similarChat}
User: ${userMessage}
Reply (be concise between 15 to 35 words, 1-2 sentences max, include a question occasionally):`;
    
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain glitched 💀";
    
    // Process reply: each sentence max 40 words; overall max 35 words.
    reply = reply
      .split(/[.!?]+/)
      .filter((sentence) => sentence.trim().length > 0)
      .map((sentence) => {
        const words = sentence.trim().split(/\s+/);
        return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
      })
      .join(". ") + ".";
    
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }
    
    // Save user message for context.
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
// Conversation Tracker & Skip Logic
// -------------------------
const conversationTracker = new Map();

function shouldReply(message) {
  const channelId = message.channel.id;
  if (!conversationTracker.has(channelId)) {
    conversationTracker.set(channelId, { count: 0, participants: new Set(), skipped: [] });
  }
  const tracker = conversationTracker.get(channelId);
  tracker.count++;
  tracker.participants.add(message.author.id);
  
  // For solo conversations: skip threshold is 1; for group: random between 1 and 2.
  let skipThreshold = 1;
  if (tracker.participants.size > 1) {
    skipThreshold = Math.floor(Math.random() * 2) + 1;
  }
  
  if (tracker.count < skipThreshold) {
    tracker.skipped.push(message.content);
    return false;
  }
  tracker.count = 0;
  return Math.random() >= 0.20; // 80% chance to reply.
}

// -------------------------
// Preset Replies for Slash Commands
// -------------------------
// 30 presets with emoji for /start.
const startRepliesEmoji = [
  "ayyy i'm awake 💀", "yo, i'm live 😎", "ready to roll 🔥", "oh snap, i'm up now 💥",
  "time to get savage 😤", "i'm online, let's wreck this 🎯", "woke and ready 💀", "rise and grind, baby 😎",
  "no sleep, all heat 🔥", "i'm here, let's do this 💯", "up and brutal 😤", "awake and raw 💥",
  "i'm live, no cap 😎", "here to roast, baby 🔥", "i'm up, let's break it down 💀", "online and savage 😤",
  "woke up mean and lean 🔥", "ready to dish it out 💯", "i'm here, bring it on 💥", "let's get it poppin' 😎",
  "up and dangerous 💀", "i'm live, no mercy 🔥", "ready for chaos 😤", "awake and brutal 💥",
  "i'm here to roast 💀", "time to show no mercy 😎", "up, raw, and ready 🔥", "i'm in the game 💯",
  "woke and wild 😤", "i'm live, let's wreck it 💥"
];

// 20 presets without emoji for /start.
const startRepliesNoEmoji = [
  "ayyy i'm awake", "yo, i'm live", "ready to roll", "oh snap, i'm up now",
  "time to get savage", "i'm online, let's wreck this", "woke and ready", "rise and grind, baby",
  "no sleep, all heat", "i'm here, let's do this", "up and brutal", "awake and raw",
  "i'm live, no cap", "here to roast, baby", "i'm up, let's break it down", "online and savage",
  "woke up mean and lean", "ready to dish it out", "i'm here, bring it on", "let's get it poppin'"
];

// 50 presets for spam /start.
const spamStartReplies = [
  "chill, i'm already live 💀", "save your energy, i'm here 😤", "hey, no need to spam /start", "already awake, bruv",
  "stop yapping, i'm online", "i'm not that slow, dude", "relax, i got this", "c'mon, i'm already chatting",
  "save it, i'm live", "i already said i'm awake 💀", "you just woke me up, now back off", "i told you i'm live",
  "no need to repeat, i'm awake", "calm down, i'm online", "i already said it, don't spam", "enough already",
  "i'm here, so zip it", "stop spamming, genius", "i heard you the first time", "save your breath, i'm live",
  "i got it, i'm awake", "enough with the start 😂", "i already told you 🗿, i'm live", "spare me the spam",
  "i'm awake, now chill 😎", "i already know you're eager", "i'm here, stop repeating", "dude, i'm not asleep",
  "i already said it, i'm live 🤣", "i'm online—enough already", "enough, i'm awake", "i'm live, don't repeat",
  "i'm already up", "i'm awake, now relax", "no more /start please", "i'm here, back off",
  "i got it, i'm live", "save it, i'm awake", "i already told you, chill out", "i'm live, enough already",
  "stop, i'm already online", "i'm awake, don't be extra", "i already said it", "i'm live, now stop", "calm down, i'm awake"
];

// 30 presets with emoji for /stop.
const stopRepliesEmoji = [
  "fine, i'm out 💀", "peace out, losers 😎", "i'm ghosting now 🔥", "later, nerds 💥",
  "imma dip now 💯", "bye, don't miss me 😤", "i'm out, catch you later 💀", "adios, suckas 😎",
  "i'm logging off now 🔥", "later, skids 💥", "i'm off, peace out 💯", "time to dip 😤",
  "i'm ghosting, bye 💀", "later, fam 😎", "i'm out, no cap 🔥", "i'm signing off 💥",
  "adios, i'm gone 💯", "i'm out, peace 😤", "bye bye, i'm out 💀", "i'm off, see ya 😎",
  "i'm dropping off now 🔥", "peace, i'm out 💥", "i'm out, later 💯", "i'm done here 😤",
  "i'm leaving, peace 💀", "later, i'm out 😎", "i'm off now 🔥", "adios, i'm done 💥", "i'm logging off 💯"
];

// 20 presets without emoji for /stop.
const stopRepliesNoEmoji = [
  "fine, i'm out", "peace out, losers", "i'm ghosting now", "later, nerds",
  "imma dip now", "bye, don't miss me", "i'm out, catch you later", "adios, suckas",
  "i'm logging off now", "later, skids", "i'm off, peace out", "time to dip",
  "i'm ghosting, bye", "later, fam", "i'm out, no cap", "i'm signing off",
  "adios, i'm gone", "i'm out, peace", "bye bye, i'm out", "i'm off, see ya"
];

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

let chatting = false;
let lastReply = "";
let lastStartCommandTime = 0;
const START_SPAM_INTERVAL = 30000; // 30 seconds

// -------------------------
// Slash Command Interaction Handler (/start, /stop, /mood)
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    
    if (interaction.commandName === "start") {
      const now = Date.now();
      // If /start is spammed (within 30 seconds) or if already active, use spam replies.
      if (chatting && now - lastStartCommandTime < START_SPAM_INTERVAL) {
        await interaction.reply(getRandomElement(spamStartReplies) + " " + getRandomEmojiSimple());
        lastStartCommandTime = now;
        return;
      }
      // Decide randomly whether to use an emoji preset or not.
      const useEmoji = Math.random() < 0.5;
      const replyText = useEmoji
        ? getRandomElement(startRepliesEmoji)
        : getRandomElement(startRepliesNoEmoji);
      chatting = true;
      lastStartCommandTime = now;
      await interaction.reply(replyText + " " + getRandomEmojiSimple());
    } else if (interaction.commandName === "stop") {
      chatting = false;
      const useEmoji = Math.random() < 0.5;
      const replyText = useEmoji
        ? getRandomElement(stopRepliesEmoji)
        : getRandomElement(stopRepliesNoEmoji);
      await interaction.reply(replyText + " " + getRandomEmojiSimple());
    } else if (interaction.commandName === "mood") {
      // The /mood command must include a mood option.
      const chosenMood = interaction.options.getString("type")?.toLowerCase();
      if (!chosenMood || !availableMoods.includes(chosenMood)) {
        await interaction.reply("Available moods: " + availableMoods.join(", "));
        return;
      }
      currentMood = chosenMood;
      await interaction.reply(`Mood set to **${currentMood}**. Gemini will now behave accordingly.`, { ephemeral: true });
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
    // Save every incoming message for context.
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [
      message.author.id,
      message.content,
      0,
    ]);
    if (!chatting) return;
    
    // 10% chance to send a meme or gif if trigger words are detected.
    const triggers = ["meme", "funny", "gif"];
    if (triggers.some(t => message.content.toLowerCase().includes(t)) && Math.random() < 0.10) {
      if (Math.random() < 0.5) {
        // Get a meme from Reddit.
        const meme = await (async function getRandomMeme() {
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
        })();
        message.channel.send(meme).catch(err => logError(err));
      } else {
        // Get a gif from Tenor.
        const gif = await (async function getRandomGif(keyword) {
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
        })("funny");
        if (gif) message.channel.send(gif).catch(err => logError(err));
      }
      return;
    }
    
    // Determine if the bot should reply based on conversation tracking.
    if (!shouldReply(message)) return;
    
    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;
    
    // Format the Gemini reply based on mood.
    const finalReply = formatResponse(replyContent, currentMood);
    // Limit to at most 5 sentences.
    const sentences = finalReply.match(/[^.!?]+[.!?]*/g) || [finalReply];
    const limitedReply = sentences.slice(0, 5).join(" ").trim();
    
    message.channel.send(limitedReply).catch(err => logError(err));
  } catch (error) {
    logError(error);
  }
});

// -------------------------
// Guild Join Event: Auto-assign "NOOBHAY" Role
// -------------------------
client.on("guildCreate", async (guild) => {
  try {
    const botMember = await guild.members.fetch(client.user.id);
    let role = guild.roles.cache.find(r => r.name === "NOOBHAY");
    if (!role) {
      role = await guild.roles.create({
        name: "NOOBHAY",
        color: "RED",
        reason: "Assigning NOOBHAY role to the bot upon joining."
      });
    }
    if (!botMember.roles.cache.has(role.id)) {
      await botMember.roles.add(role);
    }
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
// Login the Bot
// -------------------------
client.login(DISCORD_TOKEN).catch(err => logError(err));

import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from "discord.js";
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

// Create necessary tables
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

function getRandomEmoji(message) {
  if (message.guild && message.guild.emojis.cache.size > 0) {
    const emojis = Array.from(message.guild.emojis.cache.values());
    return getRandomElement(emojis).toString();
  }
  return getRandomElement(["💀", "😎", "🔥", "🤙", "🙌"]);
}

// Search chat history (past 1 year) for similar messages
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

// Get recent chat history (last 25 messages within 1 year)
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
// Gemini AI Setup & Personality Instructions
// -------------------------
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Mood instructions mapping
const moodInstructions = {
  "roasting": "savage, offensive, and aggressively roasting tone",
  "neutral": "balanced and straightforward tone",
  "happy": "cheerful, upbeat, and positive",
  "sad": "melancholic, somber, and reflective",
  "romantic": "affectionate, warm, and charming",
  "rizz": "charismatic, smooth, and playful",
  "villain arc": "dark, menacing, and villainous",
  "chill guy": "laid-back, cool, and relaxed"
};

let globalMood = "neutral"; // default mood

// Compose bot personality instructions including current mood
function getBotInstructions() {
  return `
you are noobhay tripathi, a 14-year-old human living in india who loves playing roblox.
you're offensive, savage, and cool. you roast people with a sharp tongue.
current mood: ${globalMood} - ${moodInstructions[globalMood]}.
keep responses concise: between 15 to 35 words, maximum 40 words.
use 1-2 sentences (max 5 sentences) per reply.
ask questions sometimes.
use emojis sparingly.
learn from chat history and adjust based on emotions and feedback.
preset phrases you can use: "zigga open your eyes are you fockinh dumb", "you dumbahh", "bro you know you should kys", "hell nawh kys zigga", "yeah man idc about ts tbh 💀🙏", "stop yapping bitch ahh", "bruv ;-;", "i’ll touch you", "aight ima dip now", "get ou"
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
// Gemini Chat Function with Enhanced Context & Error Handling
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
reply (be savage, concise, offensive, and cool, between 15-35 words):`;
    
    const result = await model.generateContent(prompt);
    let reply = result.response.text() || "uhhh my brain lagged 💀";
    
    // Process reply: ensure each sentence is at most 40 words and overall reply is max 35 words.
    reply = reply
      .split(/[.!?]+/)
      .filter(s => s.trim().length > 0)
      .map(sentence => {
        const words = sentence.trim().split(/\s+/);
        return words.length > 40 ? words.slice(0, 40).join(" ") : sentence.trim();
      })
      .join(". ") + ".";
      
    const totalWords = reply.split(/\s+/);
    if (totalWords.length > 35) {
      reply = totalWords.slice(0, 35).join(" ") + ".";
    }
    
    // Save message and update user behavior.
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
// Conversation Skip & Tracking
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
  
  // For solo conversations, increase skip chance to 20%
  const skipThreshold = tracker.participants.size > 1 ? 2 : 1;
  if (tracker.count < skipThreshold) {
    tracker.skipped.push(message.content);
    return false;
  }
  const chanceNotReply = tracker.participants.size > 1 ? 2 : 1;
  tracker.count = 0; // reset after threshold
  return Math.random() >= chanceNotReply;
}

// -------------------------
// Discord Client Setup
// -------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

const botName = "noobhay tripathi";
let chatting = false;
let lastReply = "";
let lastStartCommandTime = 0;

// Preset replies for /start (40 entries), spam /start (40 entries), and /stop (40 entries)
const startReplies = [
  "ayyy i'm awake 💀", "yo, what's good? 😎", "ready to spit some fire 🔥", "here to roast, let's go! 💀",
  "i'm live and savage, bro 😤", "let's get this roast on 💯", "i'm here, so prepare for burns 😏", "yo, i'm back, let's roast 😎",
  "awake and savage, bruv 🔥", "time to roast some fools 💀", "i'm up, let's burn 'em 🔥", "what's poppin'? i'm here 💯",
  "awake and ready to roast 😤", "i'm in, time for savage mode 😎", "roasting time, let's do this 💀", "get ready, i'm live and savage 🔥",
  "here to roast, what's up? 😏", "i'm here, ready to burn 🔥", "time to get savage, yo 💀", "awake and spitting roasts 😤",
  "i'm live, let's roast some clowns 😎", "ready to roast, let's go 🔥", "i'm on, prepare for fire 💀", "here to roast, bring it on 😤",
  "awake and savage, let's get it 😎", "i'm live, time to roast 💀", "ready to drop burns, let's go 🔥", "i'm here, savage mode activated 😏",
  "time to roast, bruv 💀", "awake and ready for roasts 😤", "i'm live, let's burn 'em 😎", "roast mode on, let's go 🔥",
  "i'm here, ready to get savage 💀", "time to drop some burns 😤", "awake and in savage mode 😎", "i'm live, let the roasting begin 🔥",
  "here to roast, bring your best 💀", "i'm up, time for some savage burns 😏", "ready to roast, let's do this 🔥"
];

const spamStartReplies = [
  "chill, i'm already live 💀", "save your energy, i'm here 😤", "hey, no need to spam /start", "already awake, bruv",
  "stop yapping, i'm online", "i'm not that slow, dude", "relax, i got this", "c'mon, i'm already chatting",
  "save it, i'm live", "i already said i'm awake 💀", "yo, calm down, i'm here", "duplicate alert, i'm already live",
  "spamming /start won't wake me any louder", "i'm live, no need to repeat", "duplicate command, bruv", "save your clicks, i'm already awake",
  "i got it, i'm live and savage", "you're repeating yourself, slow down", "i'm already in savage mode", "enough with the /start spam, bruv",
  "you already triggered me, chill", "i'm awake, don't spam me", "spamming /start ain't gonna change my mood", "i already said i'm live, now relax",
  "duplicate detected, i'm here", "i'm live, no need for extra noise", "chill out, i'm already active", "enough, i'm live and listening",
  "spamming won't make me more awake", "i'm already online, save it", "no need to hit /start twice", "i'm here, now stop repeating",
  "calm down, i heard you the first time", "i'm awake, now let's chat", "you've got my attention already", "spamming /start? really?",
  "i'm live, now stop spamming", "duplicate command detected, bruv", "i'm already here, enough with /start"
];

const stopReplies = [
  "fine, i'm out 💀", "peace out losers ✌️", "guess i'm not wanted huh 😒", "later, nerds 👋",
  "imma dip now 😤", "bye, don't miss me 😏", "i'm ghosting y'all 💀", "cya, losers 😏",
  "i'm out, catch you on the flip side", "adios, suckas ✌️", "time to bounce, bruv", "i'm signing off, later",
  "logging off, peace", "i'm done here, bye", "roasting over, peace out", "i'm off, see ya",
  "later, skids", "i'm out, don't wait up", "bye bye, cringe", "i'm ghost, bruv", "time to dip, yo",
  "i'm off, cya", "catch you later, losers", "i'm out, peace", "logging off, later gators",
  "bye, i'm done here", "i'm signing off, peace out", "roast complete, i'm out", "i'm bailing now, later",
  "time to vanish, cya", "i'm out, thanks for the roast", "bye, i'm disappearing", "i'm off, peace out",
  "later, fam", "i'm logging off, bye", "i'm done here, peace", "catch you on the flip side, bruv",
  "i'm out, don't miss me", "peace, i'm ghosting"
];

// -------------------------
// Slash Command Registration
// -------------------------
const commands = [
  new SlashCommandBuilder().setName('start').setDescription('Start chatting with the bot'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop the bot from chatting'),
  new SlashCommandBuilder().setName('mood')
    .setDescription('Set the bot mood')
    .addStringOption(option => 
      option.setName('mood')
        .setDescription('Choose a mood')
        .setRequired(true)
        .addChoices(
          { name: 'roasting', value: 'roasting' },
          { name: 'neutral', value: 'neutral' },
          { name: 'happy', value: 'happy' },
          { name: 'sad', value: 'sad' },
          { name: 'romantic', value: 'romantic' },
          { name: 'rizz', value: 'rizz' },
          { name: 'villain arc', value: 'villain arc' },
          { name: 'chill guy', value: 'chill guy' }
        )
    )
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      { body: commands }
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    logError(error);
  }
})();

// -------------------------
// Message Handler
// -------------------------
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    
    // Always store incoming messages
    await dbRun("INSERT INTO chat_messages (user, content, skipped) VALUES (?, ?, ?)", [message.author.id, message.content, 0]);

    if (!chatting) return;

    // 10% chance to respond with a meme or gif if trigger words are detected
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
    
    // Check conversation tracking for reply decision
    if (!shouldReply(message)) return;
    
    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;
    
    const emoji = getRandomEmoji(message);
    const finalReply = `${replyContent} ${emoji}`;
    
    // Limit reply to a maximum of 5 sentences
    const sentences = finalReply.split(/[.!?]+/).filter(s => s.trim().length > 0);
    const limitedReply = sentences.slice(0, 5).join(". ") + ".";
    
    message.channel.send(limitedReply)
      .catch(err => logError(err));
  } catch (error) {
    logError(error);
  }
});

// -------------------------
// Slash Command Interaction Handler
// -------------------------
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isCommand()) return;
    
    if (interaction.commandName === "start") {
      const now = Date.now();
      // If /start is spammed (within 30 seconds), reply with a spam preset
      if (chatting && now - lastStartCommandTime < 30000) {
        await interaction.reply(getRandomElement(spamStartReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
        lastStartCommandTime = now;
        return;
      }
      lastStartCommandTime = now;
      chatting = true;
      await interaction.reply(getRandomElement(startReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
    } else if (interaction.commandName === "stop") {
      chatting = false;
      await interaction.reply(getRandomElement(stopReplies) + " " + getRandomElement(["💀", "😎", "🔥"]));
    } else if (interaction.commandName === "mood") {
      const chosenMood = interaction.options.getString("mood");
      if (moodInstructions[chosenMood]) {
        globalMood = chosenMood;
        await interaction.reply(`mood set to ${chosenMood}. Now I'm feeling ${moodInstructions[chosenMood]} ${getRandomElement(["💀", "😎", "🔥"])}`);
      } else {
        await interaction.reply("invalid mood selected.");
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
// Express Server for Uptime Monitoring
// -------------------------
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

// -------------------------
// Login the Discord Bot
// -------------------------
client.login(DISCORD_TOKEN).catch(err => logError(err));

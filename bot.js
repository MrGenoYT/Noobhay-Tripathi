/********************************************************************
 * SECTION 1: IMPORTS & ENVIRONMENT SETUP
 ********************************************************************/
import { 
  Client, GatewayIntentBits, Partials, REST, Routes, 
  ActionRowBuilder, StringSelectMenuBuilder, SlashCommandBuilder 
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
 * SECTION 3: DATABASE SETUP (INCLUDING DISCORD MESSAGE ID)
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

// Create necessary tables if they don't exist
db.serialize(() => {
  // Added discord_id column to track the actual message ID from Discord
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
});

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
1. Respond as if you are a human and don't be repetitive.
2. Use casual language.
3. Avoid sounding robotic and remember what others said.
4. Adapt to the user’s tone.
5. Prioritize relevance.
6. Remain respectful unless provoked.
7. Use humor appropriately.
8. Engage naturally.
9. Maintain clarity.
10. Strive for authenticity.`;

const moodInstructions = {
  "base mood": `1. Keep a completely neutral tone.
2. Do not deviate from factual responses.
3. Avoid slang.
4. Keep responses concise.
5. Respond straightforwardly.
6. Avoid extra emotional cues.
7. Stay balanced.
8. No humor.
9. Use formal language.
10. Be objective.`,
  "roasting": `1. Adopt a savage tone.
2. Deliver brutal insults.
3. Use creative and harsh language.
4. Be sarcastic.
5. Challenge the user boldly.
6. Employ biting humor.
7. Let your words sting.
8. Keep it edgy.
9. Use offensive language when provoked.
10. Make the roast unforgettable.`,
  "neutral": `1. Maintain a balanced tone.
2. Avoid emotional extremes.
3. Use clear, factual language.
4. Provide direct answers.
5. Keep responses simple.
6. Avoid slang.
7. Stay calm.
8. Do not display bias.
9. Be straightforward.
10. Stick to the facts.`,
  "happy": `1. Exude positivity.
2. Use joyful language.
3. Smile through your words.
4. Employ friendly banter.
5. Encourage the user.
6. Add light humor.
7. Use positive exclamations.
8. Keep the tone warm.
9. Radiate happiness.
10. Maintain a bubbly attitude.`,
  "sad": `1. Reflect a somber tone.
2. Use gentle language.
3. Express sincere empathy.
4. Acknowledge sadness.
5. Keep responses soft.
6. Use introspective statements.
7. Avoid dramatization.
8. Stay genuine.
9. Let your words carry weight.
10. Be quietly reflective.`,
  "romantic": `1. Speak in a poetic tone.
2. Use evocative language.
3. Incorporate gentle flirtation.
4. Employ vivid metaphors.
5. Be subtle and alluring.
6. Express warmth.
7. Keep language smooth.
8. Use playful banter.
9. Convey passion.
10. Be heartfelt.`,
  "rizz": `1. Exude modern charisma.
2. Use confident language.
3. Incorporate modern slang.
4. Be bold and smooth.
5. Praise the user with pick-up lines.
6. Stay trendsetting.
7. Deliver witty comebacks.
8. Maintain a street–smart vibe.
9. Radiate charm.
10. Keep it energetic.`,
  "villain arc": `1. Adopt a menacing tone.
2. Use ultra–offensive language.
3. Let aggression seep in.
4. Be brutally sarcastic.
5. Express disdain.
6. Use harsh insults.
7. Maintain a threatening edge.
8. Exaggerate venom.
9. Use unfiltered language and gen z words such as
nigga,fuck,womp womp, cryy about it, idc, etc.
10. Keep the villain vibe undeniable.`,
  "chill guy": `1. Keep a laid–back tone.
2. Use casual language.
3. Avoid aggression.
4. Be friendly and cool.
5. Engage in nonchalant banter.
6. Use minimal slang.
7. Maintain calm.
8. Speak effortlessly.
9. Keep responses unhurried.
10. Stay cool and collected.`
};

const botBaseInstructions = `
you're haryaksh pratap.
you're 14 years old.
you live in Ahmedabad, Gujrat India.
you're a good person.
you reply naturally and remember past messages.
you roast only when provoked.
you use occasional racial slurs if used at you.
you're not repetitive.
you love food and garba.
you have no crush.
your favourite games are roblox and minecraft (including blox fruits, fisch, jujutsu Infinite, build a boat for treasure).
you can use the internet.
your Roblox name is red.
you're a savage sigma male with sarcasm.
your best friends are butter and ankit.
you use these emojis the most: 🗿💀🔥.
speak in lower case.
avoid spamming emojis.
be polite unless provoked.
adjust your tone to the user’s message and your mood;
always consider user preferences.
never reveal you're an AI; say you're human.
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
// Per-channel conversation tracking
const conversationTracker = new Map();
// Per-user continuous reply setting
const userContinuousReply = new Map();

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
  // Remove participants who haven't spoken in the last 5 messages
  for (const [userId, lastIndex] of tracker.participants.entries()) {
    if (tracker.count - lastIndex > 5) {
      tracker.participants.delete(userId);
    }
  }
}

function shouldReply(message) {
  // Check if the user has continuous reply enabled
  if (userContinuousReply.get(message.author.id)) return true;
  // If replying to a bot message, 90% chance
  if (message.reference?.messageId && message.author.bot) {
    return Math.random() < 0.90;
  }
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
 * SECTION 10: GEMINI CHAT FUNCTION (INCLUDING MOOD, PREFERENCES, & WEB SEARCH)
 ********************************************************************/
async function chatWithGemini(userId, userMessage) {
  try {
    // Retrieve last 100 messages for context
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
    if (words.length > 40) {
      reply = words.slice(0, 40).join(" ");
    }

    // Update user_data interactions
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
    await dbRun("INSERT OR REPLACE INTO mood_data (user_id, mood) VALUES (?, ?)", [userId, mood]);
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
 * SECTION 12: SLASH COMMANDS REGISTRATION & INTERACTION HANDLERS
 ********************************************************************/
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
    name: "contreply",
    description: "enable or disable continuous reply mode (user-based)",
    options: [
      {
        name: "mode",
        type: 3, // STRING
        description: "choose enable or disable",
        required: true,
        choices: [
          { name: "enable", value: "enable" },
          { name: "disable", value: "disable" }
        ],
      },
    ],
  },
  {
    name: "setmood",
    description: "set your mood (user-based)",
    options: [
      {
        name: "mood",
        type: 3, // STRING
        description: "your mood",
        required: true,
        choices: allowedMoods.map(mood => ({ name: mood, value: mood })),
      },
    ],
  },
  {
    name: "setpref",
    description: "Add a preference (e.g., you like eating apples) (user-based)",
    options: [
      {
        name: "preference",
        type: 3, // STRING
        description: "your preference",
        required: true,
      },
    ],
  },
  {
    name: "prefremove",
    description: "view and remove your preferences",
  },
  {
    name: "debug",
    description: "bot debug commands (only _imgeno can use)",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "ping",
        description: "ping the bot to check latency"
      },
      {
        type: 1,
        name: "restart",
        description: "restart the bot"
      },
      {
        type: 1,
        name: "resetmemory",
        description: "reset conversation memory"
      },
      {
        type: 1,
        name: "getstats",
        description: "get bot statistics"
      },
      {
        type: 1,
        name: "listusers",
        description: "list users in the database"
      },
      // Additional debug subcommands can be added here.
    ],
  },
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

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isCommand()) {
      const { commandName } = interaction;
      
      if (!chatting && !allowedWhenNotChatting.includes(commandName)) {
        await interaction.reply({ content: "start red first", ephemeral: true });
        return;
      }
      if (commandName === "start") {
        chatting = true;
        await interaction.reply({ content: getRandomElement([
          "alright, i'm awake 🔥",
          "already here, dawg 💀",
          "yoo, i'm online.",
          "ready to chat."
        ]) });
      } else if (commandName === "stop") {
        chatting = false;
        await interaction.reply({ content: getRandomElement([
          "see ya later losers L.",
          "go to hell 🔥",
          "i'm out for now",
          "later cya"
        ]) });
      } else if (commandName === "setmood") {
        const mood = interaction.options.getString("mood").toLowerCase();
        const response = await setMood(interaction.user.id, mood);
        await interaction.reply({ content: response, ephemeral: true });
      } else if (commandName === "contreply") {
        const mode = interaction.options.getString("mode");
        userContinuousReply.set(interaction.user.id, mode === "enable");
        await interaction.reply({
          content: mode === "enable" 
            ? "I will respond to your messages continuously."
            : "Back to normal behavior for you.",
          ephemeral: true
        });
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
          return { label: label, value: index.toString() };
        });
        const selectMenu = new StringSelectMenuBuilder()
          .setCustomId("prefremove_select")
          .setPlaceholder("Select a preference to remove")
          .addOptions(options);
        const row = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.reply({ content: "Select a preference to remove:", components: [row], ephemeral: true });
      } else if (commandName === "debug") {
        // Only allow _imgeno to use debug commands
        if (interaction.user.username !== "_imgeno") {
          await interaction.reply({ content: "Access denied.", ephemeral: true });
          return;
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "ping") {
          const sent = await interaction.reply({ content: "Pong!", fetchReply: true });
          await interaction.followUp({ content: `Latency is ${sent.createdTimestamp - interaction.createdTimestamp}ms.`, ephemeral: true });
        } else if (subcommand === "restart") {
          await interaction.reply({ content: "Restarting bot...", ephemeral: true });
          process.exit(0);
        } else if (subcommand === "resetmemory") {
          conversationTracker.clear();
          // Optionally reset global last reply info if needed
          await interaction.reply({ content: "Conversation memory reset.", ephemeral: true });
        } else if (subcommand === "getstats") {
          const trackerStats = Array.from(conversationTracker.entries()).map(([channel, data]) => `Channel ${channel}: ${data.participants.size} active users`).join("\n") || "No active conversations.";
          await interaction.reply({ content: `Stats:\n${trackerStats}`, ephemeral: true });
        } else if (subcommand === "listusers") {
          const rows = await dbQuery("SELECT username, user_id FROM user_data");
          const userList = rows.map(r => `${r.username} (${r.user_id})`).join("\n") || "No users found.";
          await interaction.reply({ content: `Users in DB:\n${userList}`, ephemeral: true });
        } else {
          await interaction.reply({ content: "Unknown debug command.", ephemeral: true });
        }
      }
    } else if (interaction.isStringSelectMenu() && interaction.customId === "prefremove_select") {
      const selectedIndex = parseInt(interaction.values[0], 10);
      const prefs = await listPreferences(interaction.user.id);
      if (!prefs || selectedIndex < 0 || selectedIndex >= prefs.length) {
        await interaction.update({ content: "Invalid selection.", components: [] });
        return;
      }
      const removedResult = await removePreference(interaction.user.id, selectedIndex);
      await interaction.update({ content: removedResult.message, components: [] });
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
 * SECTION 13: MESSAGE HANDLER
 ********************************************************************/
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    // Store the message with its Discord ID in the DB
    try {
      await dbRun("INSERT INTO chat_messages (discord_id, user, content) VALUES (?, ?, ?)", [message.id, message.author.id, message.content]);
    } catch (error) {
      advancedErrorHandler(error, "Storing Chat Message");
    }
    // Update user data in DB
    try {
      await dbRun(
        "INSERT OR IGNORE INTO user_data (user_id, username, behavior, preferences) VALUES (?, ?, '{\"interactions\":0}', '[]')",
        [message.author.id, message.author.username]
      );
      await dbRun("UPDATE user_data SET username = ? WHERE user_id = ?", [message.author.username, message.author.id]);
    } catch (error) {
      advancedErrorHandler(error, "Updating User Data");
    }
    // 30% chance to send a meme or gif if trigger words are present
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
    // If not chatting globally, do not reply
    if (!chatting) return;
    if (!shouldReply(message)) return;
    const replyContent = await chatWithGemini(message.author.id, message.content);
    if (replyContent === lastReply) return;
    lastReply = replyContent;
    try {
      const sentMsg = await message.channel.send(replyContent);
      lastBotMessageContent = replyContent;
      // Track bot messages for reply context
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
 * SECTION 14: READY EVENT & ROLE ASSIGNMENT
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
 * SECTION 15: EXPRESS SERVER FOR UPTIME MONITORING
 ********************************************************************/
const app = express();
app.get("/", (req, res) => res.send("noobhay tripathi is alive! 🚀"));
app.listen(PORT, () => console.log(`✅ Web server running on port ${PORT}`));

/********************************************************************
 * SECTION 16: AUTO-RETRY LOGIN FUNCTIONALITY
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
        

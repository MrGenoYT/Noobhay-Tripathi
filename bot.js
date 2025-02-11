import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { OpenAI } from 'openai';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// API Keys & Bot Info
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;  // Use DeepSeek API Key here
const TENOR_API_KEY = process.env.TENOR_API_KEY;  // Tenor API Key for GIFs

// Database Setup for Infinite Memory & Learning Behavior
const db = new Database('chat.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT,
        content TEXT,
        timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    );
    CREATE TABLE IF NOT EXISTS user_data (
        user_id TEXT PRIMARY KEY,
        behavior TEXT DEFAULT '{}'
    );
`);

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

// DeepSeek Setup
const openai = new OpenAI({
    baseURL: 'https://api.deepseek.com',  // DeepSeek base URL
    apiKey: DEEPSEEK_API_KEY
});

// Slash Commands Setup
const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Starts the bot chat'),
    new SlashCommandBuilder().setName('stop').setDescription('Stops the bot chat')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once('ready', async () => {
    try {
        console.log('🚀 Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
    console.log(`${botName} is online! 🚀`);
});

// Fetch & Save User Behavior
function getUserBehavior(userId) {
    const data = db.prepare("SELECT behavior FROM user_data WHERE user_id = ?").get(userId);
    return data ? JSON.parse(data.behavior) : {};
}

function saveUserBehavior(userId, behavior) {
    const existing = getUserBehavior(userId);
    const updated = { ...existing, ...behavior };
    db.prepare("INSERT INTO user_data (user_id, behavior) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET behavior = ?")
      .run(userId, JSON.stringify(updated), JSON.stringify(updated));
}

// DeepSeek Chat with Learning
async function chatWithDeepSeek(userId, userMessage) {
    const chatHistory = db.prepare("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 50").all().map(m => m.content);
    const userBehavior = getUserBehavior(userId);

    // DeepSeek chat completion request
    const completion = await openai.chat.completions.create({
        model: "deepseek-chat",  // DeepSeek's chat model
        messages: [
            {
                role: "system",
                content: `You are ${botName}, a human-like Discord bot that learns user behavior and improves responses over time. Your knowledge about this user: ${JSON.stringify(userBehavior)}`
            },
            ...chatHistory.map(m => ({ role: "user", content: m })),
            { role: "user", content: userMessage }
        ]
    });

    const reply = completion.choices?.[0]?.message?.content || "bruh, i’m having a stroke 💀";

    // Learn new behavior from the conversation
    if (reply.includes("favorite topic")) {
        userBehavior.favoriteTopic = userMessage;
        saveUserBehavior(userId, userBehavior);
    }

    return reply;
}

// Get Random Meme from Reddit
async function getRandomMeme() {
    const response = await fetch('https://www.reddit.com/r/memes/random.json');
    const data = await response.json();
    return data[0].data.children[0].data.url;
}

// Get Random GIF from Tenor
async function getRandomGif(keyword) {
    const response = await fetch(`https://api.tenor.com/v1/search?q=${keyword}&key=${TENOR_API_KEY}&limit=1`);
    const data = await response.json();
    return data.results.length ? data.results[0].media[0].gif.url : null;
}

// Gen Z Slangs
const genZSlangs = [
    "sus", "slay", "bet", "lit", "cap", "no cap", "mood", "vibe", "stan", "simp", 
    "yeet", "fam", "bussin", "woke", "fire", "clapback", "tea", "drag", "fr", "period", 
    "slaps", "savage", "flex", "fyp", "lowkey", "highkey", "sksksk", "chill", "bruh", 
    "litty", "ye", "glow up", "big yikes", "send it", "simping", "sick", "goated", "cheugy", 
    "fit", "shook", "savage", "squad", "mood", "tbh", "fomo", "fangirl", "zaddy", "tbh", "hype", 
    "bro", "dank", "slay", "clout", "rizz", "drag", "hundo p", "big brain", "sus", "catch flights"
];

// Handle Excitement & Moods (Uppercase for exclamations)
function handleMood(messageContent) {
    if (messageContent.includes("!")) {
        return messageContent.toUpperCase();
    }
    return messageContent.toLowerCase();
}

// Slash Command Handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'start') {
        chatting = true;
        return interaction.reply("Alright, I'm awake. Let's chat! 🤖");
    } else if (interaction.commandName === 'stop') {
        chatting = false;
        return interaction.reply("Fine. I'll shut up. 😶");
    }
});

// Message Handling
client.on('messageCreate', async message => {
    if (message.author.bot || !chatting) return;

    const messageContent = message.content.toLowerCase();
    lastMessageTime = Date.now();
    inactivityMessageSent = false;

    // Instant Replies for Greetings (60% chance)
    if (greetings.includes(messageContent) && Math.random() > 0.4) {
        const response = await chatWithDeepSeek(message.author.id, messageContent);
        return message.reply(handleMood(response));
    }

    messageCounter++;
    if (messageCounter < messagesBeforeReply) return;

    if (Math.random() < 0.3) return;

    messageCounter = 0;
    messagesBeforeReply = Math.floor(Math.random() * 2) + 2;

    // Meme/GIF Replies (25% chance)
    if (Math.random() < 0.25) {
        const gifUrl = await getRandomGif("funny");
        if (gifUrl) return message.reply(gifUrl);
    }

    // Gen Z Slang
    const genZResponse = genZSlangs[Math.floor(Math.random() * genZSlangs.length)];
    const aiResponse = await chatWithDeepSeek(message.author.id, message.content);
    message.reply(`${handleMood(aiResponse)} ${genZResponse}`);
});

// Inactivity Message
setInterval(() => {
    if (!chatting || inactivityMessageSent) return;
    if (Date.now() - lastMessageTime > 45 * 60 * 1000) {
        client.channels.cache.forEach(channel => {
            if (channel.isTextBased()) {
                channel.send("Yo, this place is deader than my social life. Someone say something 💀");
                inactivityMessageSent = true;
            }
        });
    }
}, 60000);

client.login(DISCORD_TOKEN);

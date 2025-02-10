const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
require('dotenv').config();

// API Keys & Bot Info
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TENOR_API_KEY = process.env.TENOR_API_KEY;

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

// OpenAI Chat with Learning
async function chatWithOpenAI(userId, userMessage) {
    const chatHistory = db.prepare("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 50").all().map(m => m.content);
    const userBehavior = getUserBehavior(userId);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: `You are ${botName}, a human-like Discord bot that learns user behavior and improves responses over time. Your knowledge about this user: ${JSON.stringify(userBehavior)}`
                },
                ...chatHistory.map(m => ({ role: "user", content: m })),
                { role: "user", content: userMessage }
            ],
            max_tokens: 150,
            temperature: 0.8
        })
    });

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "bruh, i’m having a stroke 💀";

    // Learn new behavior from the conversation
    if (reply.includes("favorite topic")) {
        userBehavior.favoriteTopic = userMessage;
        saveUserBehavior(userId, userBehavior);
    }

    return reply;
}

// Get Random Meme
async function getRandomMeme() {
    const response = await fetch('https://www.reddit.com/r/memes/random.json');
    const data = await response.json();
    return data[0].data.children[0].data.url;
}

// Get Random GIF
async function getRandomGif(keyword) {
    const response = await fetch(`https://api.tenor.com/v1/search?q=${keyword}&key=${TENOR_API_KEY}&limit=1`);
    const data = await response.json();
    return data.results.length ? data.results[0].media[0].gif.url : null;
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
        const response = await chatWithOpenAI(message.author.id, messageContent);
        return message.reply(response);
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

    const aiResponse = await chatWithOpenAI(message.author.id, message.content);
    message.reply(aiResponse);
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

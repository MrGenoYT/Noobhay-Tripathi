const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');
const Database = require('better-sqlite3');
require('dotenv').config();

// Setup SQLite Database
const db = new Database('chat.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT,
        content TEXT,
        timestamp TEXT DEFAULT (datetime('now', 'localtime'))
    )
`);

// Bot Client Setup
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel],
});

let chatting = false;
let isPaused = false;
let messageCounter = 0;
const messagesBeforeReply = Math.floor(Math.random() * 2) + 2; // 2-3 messages before responding
const slangResponses = ["skibidi", "fr bro 💀", "nahh that's crazy", "ong", "ight bet", "kk", "yep", "dawg chill", "bruh", "L take", "based", "💀", "🔥", "🤡"];

// Define Slash Commands
const commands = [
    new SlashCommandBuilder().setName('start').setDescription('Start chat mode'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop chat mode'),
    new SlashCommandBuilder()
        .setName('timepause')
        .setDescription('Pause bot responses for X minutes')
        .addIntegerOption(option =>
            option.setName('minutes')
                .setDescription('Minutes to pause')
                .setRequired(true)
        )
].map(command => command.toJSON());

// Register Slash Commands
const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log('✅ Slash commands registered.');
    } catch (error) {
        console.error('❌ Error registering commands:', error);
    }
});

// Slash Command Handling
client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'start') {
        if (chatting) return interaction.reply("aight bet, i'm already awake.. stop doing that shit 💀");
        chatting = true;
        messageCounter = 0;
        interaction.reply("ight bet, i'm awake now 🥶");
    } else if (commandName === 'stop') {
        chatting = false;
        interaction.reply("bruh i’m out, cya 😴");
    } else if (commandName === 'timepause') {
        const minutes = interaction.options.getInteger('minutes');
        isPaused = true;
        interaction.reply(`Bot paused for ${minutes} mins.`);
        setTimeout(() => {
            isPaused = false;
            interaction.followUp('Bot back online.');
        }, minutes * 60 * 1000);
    }
});

// Message Handling
client.on('messageCreate', async message => {
    if (message.author.bot) return; 

    console.log(`📩 Received message from ${message.author.username}: ${message.content}`);

    if (!chatting || isPaused) return; 

    messageCounter++;
    console.log(`💬 Message Count: ${messageCounter}/${messagesBeforeReply}`);

    if (messageCounter < messagesBeforeReply) return;

    messageCounter = 0;
    messagesBeforeReply = Math.floor(Math.random() * 2) + 2;

    if (Math.random() < 0.15) return; 

    try {
        // Save user message to SQLite
        const stmt = db.prepare("INSERT INTO chat_messages (user, content) VALUES (?, ?)");
        stmt.run(message.author.username, message.content);

        // React with a random emoji (30% chance)
        if (Math.random() < 0.30) {
            const emojis = ["😂", "💀", "🔥", "🤡", "😭", "🤣", "🥶"];
            await message.react(emojis[Math.floor(Math.random() * emojis.length)]);
        }

        // Fetch last 100 messages for AI
        const chatHistory = db.prepare("SELECT content FROM chat_messages ORDER BY timestamp DESC LIMIT 100").all();

        // Call OpenAI API
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: chatHistory.reverse().map(m => ({ role: "user", content: m.content })),
                max_tokens: 100
            })
        });

        const data = await response.json();
        let reply = data.choices?.[0]?.message?.content || slangResponses[Math.floor(Math.random() * slangResponses.length)];

        await message.reply(reply);
    } catch (error) {
        console.error("❌ Error in AI Response:", error);
        await message.reply("bruh, something broke 💀");
    }
});

// Log Errors
client.on('error', (error) => {
    console.error('❌ Discord Client Error:', error);
});

// Start Bot
client.login(process.env.BOT_TOKEN);

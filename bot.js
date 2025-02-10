const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// Define Schema & Model for Persistent Chat History
const chatSchema = new mongoose.Schema({
    user: String,
    content: String,
    timestamp: { type: Date, default: Date.now }
});
const ChatMessage = mongoose.model('ChatMessage', chatSchema);

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
const messagesBeforeReply = Math.floor(Math.random() * 2) + 2; // Reply after 2-3 messages
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
        messageCounter = 0; // Reset counter when chat starts
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

// Message Handling with Realistic Response Timing
client.on('messageCreate', async message => {
    if (message.author.bot) return; // Ignore bot messages

    console.log(`📩 Received message from ${message.author.username}: ${message.content}`);

    if (!chatting) {
        console.log("❌ Ignored message - Chat mode is OFF.");
        return;
    }

    if (isPaused) {
        console.log("⏸️ Ignored message - Bot is paused.");
        return;
    }

    messageCounter++; // Increase message count
    console.log(`💬 Message Count: ${messageCounter}/${messagesBeforeReply}`);

    if (messageCounter < messagesBeforeReply) {
        console.log("⏳ Waiting for more messages before responding.");
        return;
    }

    // Reset message counter & determine new reply interval
    messageCounter = 0;
    messagesBeforeReply = Math.floor(Math.random() * 2) + 2; // 2-3 messages

    if (Math.random() < 0.15) {
        console.log("🎲 Skipping response (15% probability).");
        return;
    }

    try {
        // Save user message to MongoDB
        await new ChatMessage({ user: message.author.username, content: message.content }).save();

        // Bot reacts with random emoji
        if (Math.random() < 0.30) {
            const emojis = ["😂", "💀", "🔥", "🤡", "😭", "🤣", "🥶"];
            await message.react(emojis[Math.floor(Math.random() * emojis.length)]);
        }

        // Fetch last 100 messages for AI
        const chatHistory = await ChatMessage.find().sort({ timestamp: -1 }).limit(100);

        // Call OpenAI API for response
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
        let reply = data.choices?.[0]?.message?.content;

        if (!reply) {
            console.error("❌ OpenAI returned empty response. Using fallback.");
            reply = slangResponses[Math.floor(Math.random() * slangResponses.length)];
        }

        await message.reply(reply);
    } catch (error) {
        console.error("❌ Error in AI Response:", error);
        await message.reply("bruh, something broke 💀");
    }
});

// Fetch Meme
async function fetchMeme() {
    try {
        const response = await fetch("https://www.reddit.com/r/memes/random.json");
        const json = await response.json();
        return json[0].data.children[0].data.url || "bruh, no memes found 💀";
    } catch (error) {
        console.error("❌ Meme fetch error:", error);
        return "bruh, meme API broke 💀";
    }
}

// Fetch GIF
async function fetchGif() {
    try {
        const response = await fetch(`https://tenor.googleapis.com/v2/search?q=random&key=${process.env.TENOR_API_KEY}&limit=1`);
        const json = await response.json();
        return json.results[0]?.url || "bruh, no GIFs found 💀";
    } catch (error) {
        console.error("❌ GIF fetch error:", error);
        return "bruh, Tenor broke 💀";
    }
}

// Log any errors
client.on('error', (error) => {
    console.error('❌ Discord Client Error:', error);
});

client.login(process.env.BOT_TOKEN);

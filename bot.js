const { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');
require('dotenv').config();

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
let chatHistory = [];
let slangResponses = ["skibidi", "fr bro 💀", "nahh that's crazy", "ong", "ight bet", "kk", "yep", "dawg chill", "bruh", "L take", "based", "💀", "🔥", "🤡"];
let memeChannels = ["memes", "funny", "random"]; // Change to actual meme channels in your server

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

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;
    const { commandName } = interaction;

    if (commandName === 'start') {
        if (chatting) return interaction.reply("aight bet, i'm already awake.. stop doing that shit 💀");
        chatting = true;
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

client.on('messageCreate', async message => {
    if (message.author.bot || !chatting || isPaused) return;

    chatHistory.push({ user: message.author.username, content: message.content });
    if (chatHistory.length > 100) chatHistory.shift(); 

    if (Math.random() < 0.10) return; // 10% chance to skip replying

    // Bot reacts with random emoji
    if (Math.random() < 0.30) {
        const emojis = ["😂", "💀", "🔥", "🤡", "😭", "🤣", "🥶"];
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        await message.react(randomEmoji);
    }

    // Fetch meme or GIF (20% probability)
    if (Math.random() < 0.20) {
        const isGif = Math.random() < 0.50;
        const memeUrl = isGif ? await fetchGif() : await fetchMeme();
        return message.reply(memeUrl);
    }

    // Check if bot is mentioned
    if (message.mentions.has(client.user)) {
        return message.reply("nuh uh, don't @ me rn 💀");
    }

    // Call OpenAI API for chat response
    try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: chatHistory.map(m => ({ role: "user", content: m.content })),
                max_tokens: 100
            })
        });

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content || slangResponses[Math.floor(Math.random() * slangResponses.length)];
        message.reply(reply);
    } catch (error) {
        console.error("❌ OpenAI Error:", error);
    }
});

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

client.login(process.env.BOT_TOKEN);

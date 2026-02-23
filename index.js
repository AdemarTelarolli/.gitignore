const express = require("express");
const fetch = require("node-fetch");
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { upsert, all } = require("./db");

const {
  BOT_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  BASE_GUILD_ID,
  VERIFIED_ROLE_ID, // 1475545732802023494
  OWNER_ID
} = process.env;

const PORT = process.env.PORT || 3000;

// ---------- Web (OAuth callback) ----------
const app = express();

async function exchangeCode(code, redirectUri) {
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("client_secret", CLIENT_SECRET);
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", redirectUri);

  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  if (!r.ok) throw new Error(`token_exchange_failed_${r.status}`);
  return r.json();
}

async function getMe(accessToken) {
  const r = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!r.ok) throw new Error(`get_me_failed_${r.status}`);
  return r.json();
}

// URL pública do Render (vamos setar em RENDER_EXTERNAL_URL)
app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send("Missing code");

    const redirectUri = `${process.env.RENDER_EXTERNAL_URL}/oauth/callback`;

    const token = await exchangeCode(code, redirectUri); // authorization code grant [web:26]
    const me = await getMe(token.access_token);

    upsert({
      user_id: me.id,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: Date.now() + (token.expires_in * 1000),
      verified_at: Date.now()
    });

    // Dar cargo no servidor base
    try {
      const guild = await bot.guilds.fetch(BASE_GUILD_ID);
      const member = await guild.members.fetch(me.id);
      await member.roles.add(VERIFIED_ROLE_ID);
    } catch (e) {
      // se o usuário ainda não estiver no servidor base, não dá para dar cargo
    }

    return res.send("Verificado! Pode voltar ao Discord.");
  } catch (e) {
    return res.status(500).send(`Erro: ${String(e.message || e)}`);
  }
});

app.listen(PORT, () => console.log("Web on", PORT));

// ---------- Bot (Discord) ----------
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

function buildAuthorizeUrl() {
  const redirectUri = `${process.env.RENDER_EXTERNAL_URL}/oauth/callback`;
  const scopes = ["identify", "guilds.join"];

  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", scopes.join(" "));
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

async function addMemberToGuild(targetGuildId, userId, userAccessToken) {
  const url = `https://discord.com/api/v10/guilds/${targetGuildId}/members/${userId}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ access_token: userAccessToken }) // Add Guild Member requires access_token in body [web:17]
  });
  return r.status; // 201 created, 204 already member [web:17]
}

async function registerCommands() {
  const cmd = new SlashCommandBuilder()
    .setName("migrar")
    .setDescription("Adiciona todos verificados no servidor destino (ID)")
    .addStringOption(o => o.setName("servidor_id").setDescription("ID do servidor destino").setRequired(true));

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [cmd.toJSON()] });
}

bot.on("ready", async () => {
  await registerCommands();
  console.log("Bot logado:", bot.user.tag);
});

bot.on("interactionCreate", async (interaction) => {
  if (interaction.isButton() && interaction.customId === "verificar") {
    return interaction.reply({ content: `Autorize aqui: ${buildAuthorizeUrl()}`, ephemeral: true });
  }

  if (interaction.isChatInputCommand() && interaction.commandName === "migrar") {
    if (OWNER_ID && interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "Sem permissão.", ephemeral: true });
    }

    const targetGuildId = interaction.options.getString("servidor_id", true);
    await interaction.reply({ content: "Migrando...", ephemeral: true });

    const users = all();
    let ok = 0, already = 0, fail = 0;

    for (const u of users) {
      const status = await addMemberToGuild(targetGuildId, u.user_id, u.access_token).catch(() => 0);
      if (status === 201) ok++;
      else if (status === 204) already++;
      else fail++;
    }

    return interaction.followUp({ content: `Finalizado. Entraram: ${ok}, já estavam: ${already}, falharam: ${fail}`, ephemeral: true });
  }
});

bot.login(BOT_TOKEN);

require("dotenv").config();

const express = require("express");
const fetch = require("node-fetch"); // v2
const Database = require("better-sqlite3");

const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require("discord.js");

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

const BASE_GUILD_ID = process.env.BASE_GUILD_ID;
const VERIFIED_ROLE_ID = process.env.VERIFIED_ROLE_ID || "1475545732802023494";
const OWNER_ID = process.env.OWNER_ID;

// URL pública FIXA (no Render você vai setar EXTERNAL_URL=https://ckverify.onrender.com)
function getExternalBaseUrl() {
  return process.env.EXTERNAL_URL || "http://localhost:3000";
}
function getRedirectUri() {
  return `${getExternalBaseUrl()}/oauth/callback`;
}
function buildAuthorizeUrl() {
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", getRedirectUri());
  u.searchParams.set("scope", "identify guilds.join");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

// Link para voltar ao Discord
function discordBackLink() {
  const g = process.env.DISCORD_GUILD_ID || BASE_GUILD_ID;
  const c = process.env.DISCORD_CHANNEL_ID;
  if (g && c) return `https://discord.com/channels/${g}/${c}`;
  return "https://discord.com/app";
}

function pageHtml(title, subtitle) {
  return `<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  :root{--bg:#0b0f19;--card:#111827;--border:#25314a;--text:#e7eaf0;--muted:rgba(231,234,240,.78);--accent:#5865F2;}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
    background:radial-gradient(1200px 800px at 20% 10%, rgba(88,101,242,.18), transparent 60%),
    radial-gradient(1000px 700px at 80% 30%, rgba(34,211,238,.12), transparent 55%), var(--bg);
    color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center}
  .card{width:min(640px,92vw);background:rgba(17,24,39,.92);backdrop-filter:blur(6px);
    border:1px solid var(--border);border-radius:18px;padding:26px 22px;box-shadow:0 18px 50px rgba(0,0,0,.45)}
  h1{margin:0 0 10px;font-size:22px}
  p{margin:0 0 18px;color:var(--muted);line-height:1.45}
  .btn{display:inline-block;background:var(--accent);color:white;text-decoration:none;padding:12px 16px;border-radius:12px;font-weight:800}
  .small{margin-top:14px;font-size:12px;color:rgba(231,234,240,.62)}
</style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${subtitle}</p>
    <a class="btn" href="${discordBackLink()}">Voltar para o Discord</a>
    <div class="small">Você pode fechar esta aba.</div>
  </div>
</body>
</html>`;
}

// ====== DB ======
const db = new Database("data.sqlite");
db.exec(`
CREATE TABLE IF NOT EXISTS verified_users (
  user_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at INTEGER,
  verified_at INTEGER NOT NULL
);
`);
function upsertUser(u) {
  db.prepare(`
    INSERT INTO verified_users (user_id, access_token, refresh_token, expires_at, verified_at)
    VALUES (@user_id, @access_token, @refresh_token, @expires_at, @verified_at)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      expires_at=excluded.expires_at,
      verified_at=excluded.verified_at
  `).run(u);
}
function allUsers() {
  return db.prepare(`SELECT * FROM verified_users`).all();
}

// ====== BOT ======
const bot = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

async function registerCommands() {
  const setup = new SlashCommandBuilder()
    .setName("setupverificar")
    .setDescription("Envia a mensagem com botão de verificação (link) neste canal")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  const migrar = new SlashCommandBuilder()
    .setName("migrar")
    .setDescription("Adiciona todos verificados no servidor destino (ID)")
    .addStringOption((o) =>
      o.setName("servidor_id").setDescription("ID do servidor destino").setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [setup.toJSON(), migrar.toJSON()] });
}

async function addMemberToGuild(targetGuildId, userId, userAccessToken) {
  const url = `https://discord.com/api/v10/guilds/${targetGuildId}/members/${userId}`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ access_token: userAccessToken }),
  });
  return r.status; // 201/204 [web:17]
}

bot.on("ready", async () => {
  await registerCommands();
  console.log("Bot logado como:", bot.user.tag);
  console.log("EXTERNAL_URL:", process.env.EXTERNAL_URL);
  console.log("Redirect URI:", getRedirectUri());
  console.log("Authorize URL:", buildAuthorizeUrl());
});

bot.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (OWNER_ID && interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: "Sem permissão.", ephemeral: true });
    }

    if (interaction.commandName === "setupverificar") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Verificar-se")
          .setStyle(ButtonStyle.Link)
          .setURL(buildAuthorizeUrl())
      );

      await interaction.channel.send({
        content: "Clique no botão abaixo para verificar:",
        components: [row],
      });

      return interaction.reply({ content: "Mensagem enviada.", ephemeral: true });
    }

    if (interaction.commandName === "migrar") {
      const targetGuildId = interaction.options.getString("servidor_id", true);
      await interaction.reply({ content: "Migrando...", ephemeral: true });

      const users = allUsers();
      let ok = 0, already = 0, fail = 0;

      for (const u of users) {
        const status = await addMemberToGuild(targetGuildId, u.user_id, u.access_token).catch(() => 0);
        if (status === 201) ok++;
        else if (status === 204) already++;
        else fail++;
      }

      return interaction.followUp({
        content: `Finalizado. Entraram: ${ok}, já estavam: ${already}, falharam: ${fail}.`,
        ephemeral: true,
      });
    }
  } catch (e) {
    if (interaction.isRepliable()) {
      return interaction.reply({ content: "Erro interno.", ephemeral: true }).catch(() => {});
    }
  }
});

bot.login(BOT_TOKEN);

// ====== WEB ======
const app = express();
const PORT = process.env.PORT || 3000;

async function exchangeCodeForToken(code) {
  const params = new URLSearchParams();
  params.append("client_id", CLIENT_ID);
  params.append("client_secret", CLIENT_SECRET);
  params.append("grant_type", "authorization_code");
  params.append("code", code);
  params.append("redirect_uri", getRedirectUri());

  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
  });
  if (!r.ok) throw new Error(`token_exchange_failed_${r.status}`);
  return r.json(); // OAuth2 [web:2]
}

async function getMe(accessToken) {
  const r = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) throw new Error(`get_me_failed_${r.status}`);
  return r.json();
}

app.get("/", (req, res) => res.status(200).send("OK"));

app.get("/oauth/callback", async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send(pageHtml("Faltou o código", "Abra a verificação pelo botão no Discord."));

    const token = await exchangeCodeForToken(code);
    const me = await getMe(token.access_token);

    upsertUser({
      user_id: me.id,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      expires_at: Date.now() + token.expires_in * 1000,
      verified_at: Date.now(),
    });

    try {
      const guild = await bot.guilds.fetch(BASE_GUILD_ID);
      const member = await guild.members.fetch(me.id);
      await member.roles.add(VERIFIED_ROLE_ID);
    } catch (e) {}

    return res.status(200).send(pageHtml("Verificação concluída", "Você já pode voltar para o Discord."));
  } catch (e) {
    return res.status(500).send(pageHtml("Erro na verificação", String(e.message || e)));
  }
});

app.listen(PORT, () => console.log("Web on", PORT));

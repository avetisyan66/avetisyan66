#!/usr/bin/env node
// Builds the profile cards straight from the GitHub GraphQL API — no third-party card services.
// Writes assets/cards/{intro,stats}-{dark,light}.svg plus the link buttons. On any API failure it exits non-zero
// before touching disk, so the last good cards stay in place.
// Everything here comes from the contribution calendar, which includes private work as bare
// counts (profile setting "Include private contributions"), so any token works — no org access needed.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LOGIN = process.env.PROFILE_LOGIN ?? "avetisyan66";
const TOKEN = process.env.GITHUB_TOKEN;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "cards");

const THEMES = {
  dark: {
    surface: "#16130D",
    stroke: "#352D1D",
    ink: "#FBF4E4",
    muted: "#B5A88C",
    faint: "#6B604A",
    yellow: "#FFD23F",
    orange: "#F7A541",
  },
  light: {
    surface: "#FFFCF2",
    stroke: "#EFE2BF",
    ink: "#2A2210",
    muted: "#76674A",
    faint: "#C8BA96",
    yellow: "#A87400",
    orange: "#C96A12",
  },
};

const FONT = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const MAX_ATTEMPTS = 4;

async function postWithRetry(body, attempt = 1) {
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status >= 500 && attempt < MAX_ATTEMPTS) throw new Error(`GitHub API ${response.status}`);
    return response;
  } catch (error) {
    if (attempt >= MAX_ATTEMPTS) throw error;
    await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    return postWithRetry(body, attempt + 1);
  }
}

async function graphql(query, variables = {}) {
  const response = await postWithRetry(JSON.stringify({ query, variables }));
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  const { data, errors } = await response.json();
  if (errors?.length) throw new Error(errors.map((error) => error.message).join("; "));
  return data;
}

async function fetchProfile() {
  const { user } = await graphql(
    `query ($login: String!) {
      user(login: $login) {
        createdAt
      }
    }`,
    { login: LOGIN },
  );
  return user;
}

async function fetchYear(year, until) {
  const { user } = await graphql(
    `query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            totalContributions
            weeks { contributionDays { date contributionCount } }
          }
        }
      }
    }`,
    {
      login: LOGIN,
      from: `${year}-01-01T00:00:00Z`,
      to: year === until.getUTCFullYear() ? until.toISOString() : `${year}-12-31T23:59:59Z`,
    },
  );
  const collection = user.contributionsCollection;
  return {
    year,
    contributions: collection.contributionCalendar.totalContributions,
    days: collection.contributionCalendar.weeks.flatMap((week) => week.contributionDays),
  };
}

function computeStreaks(days) {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  let longest = 0;
  let running = 0;
  for (const day of sorted) {
    running = day.contributionCount > 0 ? running + 1 : 0;
    longest = Math.max(longest, running);
  }
  // Today not being done yet shouldn't break the current streak.
  const settled = sorted.at(-1)?.date === today && sorted.at(-1).contributionCount === 0 ? sorted.slice(0, -1) : sorted;
  let current = 0;
  for (let index = settled.length - 1; index >= 0 && settled[index].contributionCount > 0; index -= 1) current += 1;
  return { current, longest };
}

async function collectStats() {
  const now = new Date();
  const profile = await fetchProfile();
  const joined = new Date(profile.createdAt);
  const years = [];
  for (let year = joined.getUTCFullYear(); year <= now.getUTCFullYear(); year += 1) {
    years.push(await fetchYear(year, now));
  }
  const days = years.flatMap((year) => year.days);
  const bestYear = years.reduce((best, year) => (year.contributions > best.contributions ? year : best));
  return {
    joined,
    years,
    contributions: years.reduce((total, year) => total + year.contributions, 0),
    bestYear,
    busiestDay: Math.max(...days.map((day) => day.contributionCount)),
    activeDays: days.filter((day) => day.contributionCount > 0).length,
    streaks: computeStreaks(days),
  };
}

const formatNumber = (value) => value.toLocaleString("en-US");
const escapeXml = (value) => String(value).replace(/[<>&"]/g, (char) => `&#${char.charCodeAt(0)};`);

function frame({ width, height, theme, title, subtitle, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
  <title>${escapeXml(title)}</title>
  <style>
    .fade { opacity: 0; animation: fade 0.6s ease-out forwards; }
    @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .fade { animation: none !important; opacity: 1 !important; } }
  </style>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="${theme.surface}" stroke="${theme.stroke}"/>
  <text x="28" y="40" font-family="${MONO}" font-size="15" font-weight="700" fill="${theme.yellow}">${escapeXml(title)}</text>
  <text x="${width - 28}" y="40" text-anchor="end" font-family="${MONO}" font-size="12" fill="${theme.muted}">${escapeXml(subtitle)}</text>
${body}
</svg>
`;
}

function renderStats(stats, theme) {
  const width = 840;
  const height = 230;
  const tiles = [
    { label: "active days", value: stats.activeDays },
    { label: "longest streak", value: stats.streaks.longest, unit: "days" },
    { label: "current streak", value: stats.streaks.current, unit: "days" },
    { label: "per active day", value: Math.round((stats.contributions / Math.max(stats.activeDays, 1)) * 10) / 10 },
    { label: `best year (${stats.bestYear.year})`, value: stats.bestYear.contributions },
    { label: "busiest day", value: stats.busiestDay },
  ];
  const columns = 3;
  const tileWidth = 164;
  const tileHeight = 64;
  const gridX = 300;

  const hero = `
  <g class="fade">
    <text x="28" y="118" font-family="${FONT}" font-size="56" font-weight="800" fill="${theme.ink}">${formatNumber(stats.contributions)}</text>
    <text x="30" y="146" font-family="${MONO}" font-size="13" fill="${theme.muted}">lifetime contributions</text>
    <text x="30" y="166" font-family="${MONO}" font-size="12" fill="${theme.faint}">public + private · since ${stats.joined.getUTCFullYear()}</text>
  </g>`;

  const grid = tiles
    .map((tile, index) => {
      const x = gridX + (index % columns) * (tileWidth + 12);
      const y = 64 + Math.floor(index / columns) * (tileHeight + 12);
      const accent = index < 2 ? theme.yellow : theme.orange;
      return `
  <g class="fade" style="animation-delay:${0.15 + index * 0.08}s">
    <rect x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" rx="10" fill="none" stroke="${theme.stroke}"/>
    <rect x="${x}" y="${y + 14}" width="3" height="${tileHeight - 28}" rx="1.5" fill="${accent}"/>
    <text x="${x + 16}" y="${y + 32}" font-family="${FONT}" font-size="22" font-weight="700" fill="${theme.ink}">${formatNumber(tile.value)}${tile.unit ? `<tspan font-size="12" font-weight="400" fill="${theme.muted}"> ${tile.unit}</tspan>` : ""}</text>
    <text x="${x + 16}" y="${y + 50}" font-family="${MONO}" font-size="12" fill="${theme.muted}">${tile.label}</text>
  </g>`;
    })
    .join("");

  return frame({
    width,
    height,
    theme,
    title: "~/lifetime-on-github",
    subtitle: `updated ${new Date().toISOString().slice(0, 10)}`,
    body: hero + grid,
  });
}

const INTRO_LINES = [
  [["// ani.ts — hi, glad you're here", "muted"]],
  [["const ", "orange"], ["ani", "ink"], [" = {", "muted"]],
  [["  role", "ink"], [": ", "muted"], ['"JavaScript / TypeScript engineer"', "yellow"], [",", "muted"]],
  [["  stack", "ink"], [": [", "muted"], ['"React Native"', "yellow"], [", ", "muted"], ['"React"', "yellow"], [", ", "muted"], ['"Next.js"', "yellow"], [", ", "muted"], ['"Node"', "yellow"], [", ", "muted"], ['"GraphQL"', "yellow"], ["],", "muted"]],
  [["  based", "ink"], [": ", "muted"], ['"Yerevan, Armenia"', "yellow"], [",", "muted"]],
  [["  loves", "ink"], [": ", "muted"], ['"scalable web & mobile apps"', "yellow"], [",", "muted"]],
  [["  fuel", "ink"], [": ", "muted"], ['"pineapples & coffee"', "yellow"], [",", "muted"]],
  [["  motto", "ink"], [": ", "muted"], ['"Work hard ~ Party harder"', "yellow"], [",", "muted"]],
  [["};", "muted"]],
];

function renderIntro(theme) {
  const width = 840;
  const lineHeight = 26;
  const charWidth = 9.05;
  const top = 78;
  const height = top + (INTRO_LINES.length - 1) * lineHeight + 30;
  const typingSpeed = 0.028;
  let startAt = 0.4;

  const lines = INTRO_LINES.map((tokens, index) => {
    const y = top + index * lineHeight;
    const length = tokens.reduce((total, [text]) => total + text.length, 0);
    const duration = Math.max(0.15, length * typingSpeed);
    const begin = startAt;
    startAt += duration + 0.12;
    const spans = tokens.map(([text, color]) => `<tspan fill="${theme[color]}">${escapeXml(text)}</tspan>`).join("");
    return `
  <clipPath id="line-${index}"><rect x="56" y="${y - 18}" height="${lineHeight}" width="0">
    <animate attributeName="width" from="0" to="${length * charWidth + 4}" begin="${begin.toFixed(2)}s" dur="${duration.toFixed(2)}s" fill="freeze" calcMode="discrete" keyTimes="${discreteKeyTimes(length)}" values="${discreteValues(length, charWidth)}"/>
  </rect></clipPath>
  <text x="28" y="${y}" font-family="${MONO}" font-size="13" fill="${theme.faint}" text-anchor="start">${String(index + 1).padStart(2, " ")}</text>
  <text x="60" y="${y}" font-family="${MONO}" font-size="15" xml:space="preserve" clip-path="url(#line-${index})">${spans}</text>`;
  }).join("");

  const lastY = top + (INTRO_LINES.length - 1) * lineHeight;
  const cursorX = 60 + INTRO_LINES.at(-1).reduce((total, [text]) => total + text.length, 0) * charWidth + 4;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Ani Avetisyan — JavaScript / TypeScript engineer from Yerevan, Armenia. React Native, React, Next.js, Node, GraphQL.">
  <title>Ani Avetisyan — JavaScript / TypeScript engineer from Yerevan, Armenia</title>
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="${theme.surface}" stroke="${theme.stroke}"/>
  <circle cx="30" cy="28" r="6" fill="${theme.yellow}"/>
  <circle cx="50" cy="28" r="6" fill="${theme.orange}"/>
  <circle cx="70" cy="28" r="6" fill="${theme.faint}"/>
  <text x="${width / 2}" y="32" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${theme.muted}">~/avetisyan66/ani.ts</text>
  <line x1="0" y1="50.5" x2="${width}" y2="50.5" stroke="${theme.stroke}"/>
${lines}
  <rect x="${cursorX}" y="${lastY - 14}" width="9" height="18" rx="1" fill="${theme.yellow}" opacity="0">
    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.01;0.5;0.51" dur="1s" begin="${startAt.toFixed(2)}s" repeatCount="indefinite"/>
  </rect>
</svg>
`;
}

function discreteKeyTimes(length) {
  return Array.from({ length: length + 1 }, (_, step) => (step / length).toFixed(4)).join(";");
}

function discreteValues(length, charWidth) {
  return Array.from({ length: length + 1 }, (_, step) => (step * charWidth + (step === length ? 4 : 0)).toFixed(1)).join(";");
}

const BUTTONS = [
  { name: "portfolio", label: "avetisyan66.github.io", caption: "portfolio", fill: "#FFD23F", ink: "#2A2210", icon: "globe" },
  { name: "linkedin", label: "in/avetisyan66", caption: "linkedin", fill: "#F7A541", ink: "#2A2210", icon: "in" },
];

const ICONS = {
  globe: (ink) => `<g fill="none" stroke="${ink}" stroke-width="1.6"><circle cx="28" cy="24" r="9"/><ellipse cx="28" cy="24" rx="4" ry="9"/><line x1="19" y1="24" x2="37" y2="24"/></g>`,
  in: (ink, fill) => `<rect x="19" y="15" width="18" height="18" rx="4" fill="${ink}"/><text x="28" y="29" text-anchor="middle" font-family="${FONT}" font-size="12" font-weight="800" fill="${fill}">in</text>`,
};

function renderButton(button) {
  const width = 236;
  const height = 48;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${button.caption}: ${button.label}">
  <rect width="${width}" height="${height}" rx="24" fill="${button.fill}"/>
  ${ICONS[button.icon](button.ink, button.fill)}
  <text x="48" y="21" font-family="${MONO}" font-size="10" letter-spacing="1.5" fill="${button.ink}" opacity="0.75">${button.caption.toUpperCase()}</text>
  <text x="48" y="36" font-family="${FONT}" font-size="14" font-weight="700" fill="${button.ink}">${button.label} ↗</text>
</svg>
`;
}

async function main() {
  if (!TOKEN) throw new Error("Set GITHUB_TOKEN to query the GitHub API.");
  const stats = await collectStats();
  const cards = [
    ...Object.entries(THEMES).flatMap(([mode, theme]) => [
      [`intro-${mode}.svg`, renderIntro(theme)],
      [`stats-${mode}.svg`, renderStats(stats, theme)],
    ]),
    ...BUTTONS.map((button) => [`${button.name}.svg`, renderButton(button)]),
  ];
  await mkdir(OUT_DIR, { recursive: true });
  await Promise.all(cards.map(([name, svg]) => writeFile(join(OUT_DIR, name), svg)));
  console.log(
    `contributions=${stats.contributions} active=${stats.activeDays} best=${stats.bestYear.year}:${stats.bestYear.contributions} busiest=${stats.busiestDay} streak=${stats.streaks.current}/${stats.streaks.longest}`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

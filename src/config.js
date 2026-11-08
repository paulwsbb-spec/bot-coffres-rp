import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  channels: {},
  acceptNonWebhookMessages: false,
  alertChannelId: '',
  alerts: { moneyWithdrawThreshold: 100000, itemWithdrawThreshold: 50, watchItems: [] },
  moneyItems: {
    cash: ['money', 'cash', 'argent', 'argent propre', 'liquide', 'dollars', 'dollar', 'billets'],
    black_money: ['black_money', 'black money', 'argent sale', 'dirty money', 'markedbills', 'marked bills'],
  },
  itemAliases: {},
  coffreAliases: {},
  rules: [],
};

export function loadConfig(file = path.join(ROOT, 'config.json')) {
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...DEFAULTS,
    ...user,
    alerts: { ...DEFAULTS.alerts, ...(user.alerts || {}) },
    moneyItems: { ...DEFAULTS.moneyItems, ...(user.moneyItems || {}) },
  };
}

export const env = {
  token: process.env.DISCORD_TOKEN || '',
  guildId: process.env.GUILD_ID || '',
  port: Number(process.env.DASHBOARD_PORT || 3000),
  password: process.env.DASHBOARD_PASSWORD || '',
  dashboardUrl: process.env.DASHBOARD_URL || `http://localhost:${process.env.DASHBOARD_PORT || 3000}`,
  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/coffres.db'),
};

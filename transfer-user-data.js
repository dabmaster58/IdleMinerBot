import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMongoDatabase } from './mongo.js';
import { getMineName, getMineNumber } from './utils/mineLooker.js';
import { getContinentByMineNumber, getContinentName, normalizeOwnedContinents } from './utils/continentLooker.js';
import { normalizeUserPreferences } from './utils/userPreferences.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sourcePath = path.join(__dirname, 'config', 'user_data', 'firebase_data.json');
const legacyValue = (source, snakeCase, camelCase, fallback = undefined) => source?.[snakeCase] ?? source?.[camelCase] ?? fallback;
function resolveMineNumber(value, fallback = 1) { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n > 0 ? n : (getMineNumber(value) || fallback); }
function normalizeLegacyMine(mine = {}) {
    const mineNumber = resolveMineNumber(legacyValue(mine, 'mine_number', 'MineNumber', legacyValue(mine, 'mineNumber', 'mine_name', legacyValue(mine, 'mineName', 'mine'))));
    return { prestige_count: Number(legacyValue(mine, 'prestige_count', 'PrestigeCount', 0)) || 0, mine_number: mineNumber, mine_name: getMineName(mineNumber), continent_name: getContinentName(mineNumber), factor: Number(legacyValue(mine, 'factor', 'Factor', 1)) || 1, barriers: legacyValue(mine, 'barriers', 'Barriers', []) || [], elevator: legacyValue(mine, 'elevator', 'Elevator', []) || [], warehouse: legacyValue(mine, 'warehouse', 'Warehouse', []) || [], managers: legacyValue(mine, 'managers', 'Managers', { shaft: [], elevator: [], warehouse: [] }) || { shaft: [], elevator: [], warehouse: [] }, mineshafts: legacyValue(mine, 'mineshafts', 'Mineshafts', []) || [] };
}
function standardizeCashFields(data) { return Object.fromEntries([['cash','cash'],['ice_cash','iceCash'],['fire_cash','fireCash'],['dawn_cash','dawnCash'],['idle_cash','idleCash'],['idle_ice_cash','idleIceCash'],['idle_fire_cash','idleFireCash'],['idle_dawn_cash','idleDawnCash']].map(([a,b]) => [a, Number(legacyValue(data, a, b, 0)) || 0])); }
export function transformUserData(data = {}) {
    const userId = String(legacyValue(data, 'user_id', 'userId', '') || '').trim();
    const currentMineNumber = resolveMineNumber(legacyValue(data, 'current_mine', 'currentMine', 1));
    const legacyMines = Array.isArray(data.mines) ? data.mines : Object.values(data.mines || {});
    const mines = (legacyMines.length ? legacyMines : [{ mine_number: currentMineNumber }]).map(normalizeLegacyMine);
    const currentMine = mines.find(m => m.mine_number === currentMineNumber) || mines[0];
    const currentContinent = getContinentByMineNumber(currentMine.mine_number)?.name || getContinentName(currentMine.mine_number);
    const hasPremium = Boolean(legacyValue(data, 'has_premium', 'hasPremium', false));
    return { user_id: userId, userId, username: String(legacyValue(data, 'username', 'username', '') || ''), created_at: legacyValue(data, 'created_at', 'createdAt', new Date().toISOString()), continents: normalizeOwnedContinents(legacyValue(data, 'continents', 'continents', [currentContinent])), current_continent: currentContinent, current_mine: currentMine.mine_name, ...standardizeCashFields(data), super_cash: Number(legacyValue(data, 'super_cash', 'superCash', 0)) || 0, streak: Number(legacyValue(data, 'streak', 'streak', 0)) || 0, last_daily: Number(legacyValue(data, 'last_daily', 'lastDaily', 0)) || 0, last_idle: Number(legacyValue(data, 'last_idle', 'lastIdle', 0)) || 0, last_idle_accrued_at: Number(legacyValue(data, 'last_idle_accrued_at', 'lastIdleAccruedAt', 0)) || 0, last_monthly: Number(legacyValue(data, 'last_monthly', 'lastMonthly', 0)) || 0, has_premium: hasPremium, active_boosts: legacyValue(data, 'active_boosts', 'activeBoosts', []) || [], inventory: legacyValue(data, 'inventory', 'inventory', {}) || {}, preferences: normalizeUserPreferences(legacyValue(data, 'preferences', 'preferences', null), hasPremium), mines };
}
export async function initializeTransferredUser(data) {
    if (!data?.user_id) throw new TypeError('A transferred user must have a user ID.');
    const users = getMongoDatabase().collection('users');
    const result = await users.updateOne({ _id: data.user_id }, { $setOnInsert: { _id: data.user_id, id: data.user_id, data, version: 1, updated_at: new Date() } }, { upsert: true });
    if (!result.upsertedCount) { console.log(`User ${data.username || data.user_id} already exists.`); return false; }
    console.log(`Transferred user ${data.username || data.user_id}.`); return true;
}
export async function migrateData(filePath = sourcePath) { const data = JSON.parse(fs.readFileSync(filePath, 'utf8')); const records = Array.isArray(data) ? data : Object.values(data || {}); let count = 0; for (const item of records) { const transformed = transformUserData(item); if (!transformed.user_id) { console.warn('Skipping legacy record without a user ID.'); continue; } if (await initializeTransferredUser(transformed)) count += 1; } return count; }
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) migrateData().then(count => console.log(`Migration complete (${count} users transferred).`)).catch(error => { console.error('Migration error:', error?.message || error); process.exitCode = 1; });

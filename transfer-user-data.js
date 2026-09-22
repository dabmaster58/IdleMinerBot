import { AsyncLocalStorage } from 'node:async_hooks';
import { getMongoDatabase } from './mongo.js';
import { normalizeOwnedContinents } from './utils/continentLooker.js';
import { normalizeUserPreferences } from './utils/userPreferences.js';
import mineRegionsJson from './config/mineRegions.json' with { type: 'json' };
import continentDataJson from './config/continentData.json' with { type: 'json' };

const mineRegions = mineRegionsJson.regions || [];
const continentData = continentDataJson.continents || [];
const MAX_TRANSACTION_RETRIES = 25;
const DB_TIMEOUT_MS = 8_000;
const READ_CACHE_TTL_MS = 1_000;
const userLockStorage = new AsyncLocalStorage();
const USER_SNAPSHOT = Symbol('idleMinerUserSnapshot');

function clone(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
}

function valuesEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function attachUserSnapshot(user, snapshot) {
    if (!user || typeof user !== 'object' || !snapshot || typeof snapshot !== 'object') return user;
    Object.defineProperty(user, USER_SNAPSHOT, {
        value: clone(snapshot),
        enumerable: false,
        configurable: true
    });
    return user;
}

function deriveUserPatch(baseline, candidate) {
    if (!baseline || !candidate || typeof baseline !== 'object' || typeof candidate !== 'object') {
        return clone(candidate);
    }

    const patch = {};
    for (const [key, value] of Object.entries(candidate)) {
        if (!Object.prototype.hasOwnProperty.call(baseline, key) || !valuesEqual(baseline[key], value)) {
            patch[key] = clone(value);
        }
    }
    return patch;
}

function isDiscordUserId(userId) {
    return /^\d{17,20}$/.test(String(userId || '').trim());
}

function isTestUser(userId, data = null) {
    const id = String(userId || '').trim();
    const embeddedUserId = String(data?.user_id || data?.userId || '').trim();
    return !isDiscordUserId(id)
        || (embeddedUserId !== '' && !isDiscordUserId(embeddedUserId));
}

function normalizeUserDocument(row) {
    if (!row || row.data === undefined || row.data === null) return null;

    const data = clone(row.data);
    const canonicalUserId = data.user_id || data.userId || row.id || row._id;
    if (canonicalUserId) {
        data.user_id = data.user_id || canonicalUserId;
        data.userId = data.userId || canonicalUserId;
    }
    data.preferences = normalizeUserPreferences(data.preferences, data.has_premium);
    return data;
}

async function withTimeout(request, message) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve(request),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), DB_TIMEOUT_MS);
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function createDataManager(dbProvider = () => getMongoDatabase(), { allowSyntheticUserIds = false } = {}) {
    const userWriteQueues = new Map();
    const readCache = new Map();

    const userCollection = () => dbProvider().collection('users');
    const sessionCollection = () => dbProvider().collection('interaction_sessions');

    function cacheGet(userId) {
        const entry = readCache.get(userId);
        if (!entry || entry.expiresAt <= Date.now()) {
            readCache.delete(userId);
            return undefined;
        }
        return clone(entry.data);
    }

    function cacheSet(userId, data) {
        readCache.set(userId, {
            data: clone(data),
            expiresAt: Date.now() + READ_CACHE_TTL_MS
        });
    }

    function enqueueUserWrite(userId, operation) {
        const previous = userWriteQueues.get(userId) || Promise.resolve();
        const queued = previous.catch(() => undefined).then(operation);
        userWriteQueues.set(userId, queued);
        queued.then(
            () => {
                if (userWriteQueues.get(userId) === queued) userWriteQueues.delete(userId);
            },
            () => {
                if (userWriteQueues.get(userId) === queued) userWriteQueues.delete(userId);
            }
        );
        return queued;
    }

    async function fetchRow(table, id) {
        const collection = table === 'users' ? userCollection() : sessionCollection();
        const request = collection.findOne({ _id: id });
        const row = await withTimeout(request, `Database read timed out for ${table}/${id}.`);
        return row || null;
    }

    async function mutateRow(table, id, mutator) {
        const collection = table === 'users' ? userCollection() : sessionCollection();

        for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
            const row = await fetchRow(table, id);
            const current = table === 'users'
                ? normalizeUserDocument(row)
                : clone(row?.data ?? null);
            const nextValue = await mutator(clone(current));
            const next = table === 'users' && nextValue
                ? normalizeUserDocument({ id, data: nextValue })
                : nextValue;

            if (next === undefined || next === null) {
                return { committed: false, user: current };
            }
            if (typeof next !== 'object' || Array.isArray(next)) {
                throw new TypeError('Data transaction mutator must return an object or undefined.');
            }

            if (!row) {
                try {
                    await collection.insertOne({
                        _id: id,
                        id,
                        data: next,
                        version: 1,
                        updated_at: new Date()
                    });
                    if (table === 'users') cacheSet(id, next);
                    return { committed: true, user: next };
                } catch (error) {
                    if (error?.code === 11000) continue;
                    throw error;
                }
            }

            const currentVersion = Number.isFinite(Number(row.version)) && Number(row.version) >= 0
                ? Number(row.version)
                : 0;

            const updated = await collection.findOneAndUpdate(
                { _id: id, version: currentVersion },
                {
                    $set: {
                        data: next,
                        version: currentVersion + 1,
                        updated_at: new Date()
                    }
                },
                { returnDocument: 'after' }
            );

            if (updated && updated.value) {
                if (table === 'users') cacheSet(id, updated.value.data);
                return { committed: true, user: updated.value.data };
            }
        }

        throw new Error(`Transaction for ${table}/${id} was not committed after ${MAX_TRANSACTION_RETRIES} retries.`);
    }

    function runUserWrite(userId, operation) {
        if (userLockStorage.getStore() === userId) return operation();
        return enqueueUserWrite(userId, operation);
    }

    async function initializeUser(userId, username) {
        if (!userId || (!allowSyntheticUserIds && isTestUser(userId))) {
            throw new TypeError('initializeUser requires a valid Discord user ID.');
        }

        return runUserWrite(userId, async () => {
            const existing = await fetchRow('users', userId);
            if (existing) return normalizeUserDocument(existing);

            const user = {
                user_id: userId,
                userId,
                username: username || '',
                created_at: new Date().toISOString(),
                continents: normalizeOwnedContinents([continentData[0]?.ContinentName || 'Start Continent']),
                current_continent: 'Start Continent',
                current_mine: 'Coal Mine',
                cash: 10,
                ice_cash: 0,
                fire_cash: 0,
                dawn_cash: 0,
                idle_cash: 0,
                idle_ice_cash: 0,
                idle_fire_cash: 0,
                idle_dawn_cash: 0,
                mines: [{
                    prestige_count: 0,
                    mine_number: 1,
                    mine_name: 'Coal Mine',
                    continent_name: 'Start Continent',
                    factor: 1,
                    mineshafts: [],
                    elevator: [],
                    warehouse: [],
                    managers: { shaft: [], elevator: [], warehouse: [] },
                    barriers: mineRegions.map((region, index) => ({
                        ...region,
                        unlocked: index === 0
                    }))
                }],
                super_cash: 0,
                streak: 0,
                last_daily: 0,
                last_idle: 0,
                last_idle_accrued_at: 0,
                last_monthly: 0,
                has_premium: false,
                active_boosts: [],
                inventory: {},
                preferences: normalizeUserPreferences(null, false)
            };

            try {
                await userCollection().insertOne({
                    _id: userId,
                    id: userId,
                    data: user,
                    version: 1,
                    updated_at: new Date()
                });
                const normalizedUser = normalizeUserDocument({ _id: userId, id: userId, data: user });
                cacheSet(userId, normalizedUser);
                return clone(normalizedUser);
            } catch (error) {
                if (error?.code !== 11000) throw error;
                const concurrentRow = await fetchRow('users', userId);
                return concurrentRow ? normalizeUserDocument(concurrentRow) : null;
            }
        });
    }

    async function getUser(userId) {
        if (!userId || (!allowSyntheticUserIds && isTestUser(userId))) return null;

        try {
            const cached = cacheGet(userId);
            if (cached !== undefined) return attachUserSnapshot(cached, cached);

            const row = await fetchRow('users', userId);
            if (!row?.data) return null;
            if (!allowSyntheticUserIds && isTestUser(row.id, row.data)) return null;

            const user = normalizeUserDocument(row);
            cacheSet(userId, user);
            return attachUserSnapshot(clone(user), user);
        } catch (error) {
            console.error(`Error fetching user ${userId}:`, error?.message || error);
            return null;
        }
    }

    async function updateUser(userId, updates) {
        if (!userId || (!allowSyntheticUserIds && isTestUser(userId))) {
            throw new TypeError('updateUser requires a valid Discord user ID.');
        }
        if (!updates || typeof updates !== 'object' || Array.isArray(updates) || !Object.keys(updates).length) {
            throw new TypeError('updateUser requires a non-empty update object.');
        }

        return runUserWrite(userId, async () => {
            const baseline = updates?.[USER_SNAPSHOT] || cacheGet(userId);
            const candidate = clone(updates);
            const patch = candidate.user_id || candidate.userId
                ? deriveUserPatch(baseline, candidate)
                : candidate;
            if (!Object.keys(patch || {}).length) {
                return normalizeUserDocument({ _id: userId, id: userId, data: baseline || candidate });
            }

            const result = await mutateRow('users', userId, current => ({
                ...(current || {}),
                ...patch
            }));
            if (!result.committed) throw new Error(`User update for ${userId} was not committed.`);
            return normalizeUserDocument({ _id: userId, id: userId, data: result.user });
        });
    }

    async function updateUserTransaction(userId, mutator) {
        if (!userId || (!allowSyntheticUserIds && isTestUser(userId)) || typeof mutator !== 'function') {
            throw new TypeError('updateUserTransaction requires a valid user ID and mutator.');
        }

        return runUserWrite(userId, async () => {
            const result = await mutateRow('users', userId, mutator);
            return {
                committed: result.committed,
                aborted: !result.committed,
                user: result.user ? normalizeUserDocument({ _id: userId, id: userId, data: result.user }) : result.user
            };
        });
    }

    async function commitUserSnapshot(userId, candidate) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
            throw new TypeError('commitUserSnapshot requires a user document.');
        }
        const baseline = candidate[USER_SNAPSHOT] || cacheGet(userId);
        const patch = deriveUserPatch(baseline, candidate);
        if (!Object.keys(patch).length) {
            return { committed: false, aborted: true, user: clone(baseline || candidate) };
        }
        return updateUserTransaction(userId, current => ({
            ...(current || {}),
            ...patch
        }));
    }

    async function removeUser(userId, userData = null) {
        if (!userId || !isTestUser(userId, userData)) return false;
        const result = await userCollection().deleteOne({ _id: userId });
        if (result.deletedCount) readCache.delete(userId);
        return result.deletedCount > 0;
    }

    async function removeTestUsers() {
        const rows = await userCollection().find({}).toArray();
        let removed = 0;
        for (const row of rows) {
            if (await removeUser(row.id, row.data)) removed += 1;
        }
        return removed;
    }

    async function getAllUsers() {
        const rows = await userCollection().find({}).toArray();
        const users = {};
        for (const row of rows) {
            if (!allowSyntheticUserIds && isTestUser(row.id, row.data)) continue;
            users[row.id] = normalizeUserDocument(row) || {};
        }
        return users;
    }

    async function createInteractionSession(sessionId, sessionData) {
        if (!sessionId || !sessionData || typeof sessionData !== 'object') {
            throw new TypeError('createInteractionSession requires a session ID and session data.');
        }
        await sessionCollection().updateOne(
            { _id: sessionId },
            { $set: { id: sessionId, data: clone(sessionData), updated_at: new Date() } },
            { upsert: true }
        );
        return sessionData;
    }

    async function closeInteractionSession(sessionId, reason = 'collector-ended') {
        if (!sessionId) return false;
        const row = await fetchRow('interaction_sessions', sessionId);
        if (!row) return false;
        await sessionCollection().updateOne(
            { _id: sessionId },
            {
                $set: {
                    data: {
                        ...(row.data || {}),
                        status: 'closed',
                        closeReason: reason,
                        closedAt: Date.now()
                    },
                    updated_at: new Date()
                }
            }
        );
        return true;
    }

    async function getAllInteractionSessions() {
        const rows = await sessionCollection().find({}).toArray();
        return Object.fromEntries(rows.map(row => [row.id, row.data || {}]));
    }

    async function removeInteractionSession(sessionId) {
        if (!sessionId) return false;
        const result = await sessionCollection().deleteOne({ _id: sessionId });
        return result.deletedCount > 0;
    }

    function withUserLock(userId, operation) {
        if (!userId || typeof operation !== 'function') {
            throw new TypeError('withUserLock requires a user ID and operation.');
        }
        if (userLockStorage.getStore() === userId) return operation();
        return enqueueUserWrite(userId, () => userLockStorage.run(userId, operation));
    }

    async function mutateUser(userId, mutator, errorContext = 'mutateUser') {
        if (!userId || typeof mutator !== 'function') {
            throw new TypeError('mutateUser requires a user ID and mutator.');
        }

        return withUserLock(userId, async () => {
            const user = await getUser(userId);
            if (!user) return null;

            try {
                const result = await mutator(user);
                if (result === false) return user;
                const updates = result && typeof result === 'object' && !Array.isArray(result)
                    ? result
                    : user;
                return await updateUser(userId, updates);
            } catch (error) {
                error.context = errorContext;
                throw error;
            }
        });
    }

    return {
        initializeUser,
        getUser,
        updateUser,
        updateUserTransaction,
        commitUserSnapshot,
        mutateUser,
        withUserLock,
        getAllUsers,
        removeUser,
        removeTestUsers,
        createInteractionSession,
        closeInteractionSession,
        getAllInteractionSessions,
        removeInteractionSession
    };
}

const dataManager = createDataManager();
export { createDataManager };
export const {
    initializeUser,
    getUser,
    updateUser,
    updateUserTransaction,
    commitUserSnapshot,
    mutateUser,
    withUserLock,
    getAllUsers,
    removeUser,
    removeTestUsers,
    createInteractionSession,
    closeInteractionSession,
    getAllInteractionSessions,
    removeInteractionSession,
} = dataManager;
export default dataManager;

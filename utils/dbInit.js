'use strict';

import { getMongoDatabase, initializeMongo } from '../mongo.js';

const DB_CHECK_TIMEOUT_MS = 8000;
export const REQUIRED_COLLECTIONS = ['users', 'interaction_sessions'];
export const OPTIONAL_COLLECTIONS = [];

export async function initializeDatabase() {
    const result = Object.fromEntries([...REQUIRED_COLLECTIONS, ...OPTIONAL_COLLECTIONS].map(name => [name, false]));
    try {
        await Promise.race([
            initializeMongo(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('MongoDB connection check timed out.')), DB_CHECK_TIMEOUT_MS))
        ]);
        const collections = new Set((await getMongoDatabase().listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
        // MongoDB creates collections lazily; ensure the required collections exist.
        for (const name of REQUIRED_COLLECTIONS) {
            if (!collections.has(name)) await getMongoDatabase().createCollection(name);
            result[name] = true;
        }
        for (const name of OPTIONAL_COLLECTIONS) result[name] = collections.has(name);
        result.allReady = true;
        console.log('MongoDB initialization check passed - all required collections are ready.');
    } catch (error) {
        result.allReady = false;
        console.warn(`MongoDB initialization check failed: ${error?.message || error}`);
        console.warn('Set MONGODB_URI (and optionally MONGODB_DATABASE) in .env and ensure the database is reachable.');
    }
    return result;
}

export async function isDatabaseReady() { return (await initializeDatabase()).allReady; }
export async function safeDbOperation(operation, fallback = null) {
    try { return await operation(); } catch (error) { console.error('Database operation failed:', error?.message || error); return fallback; }
}

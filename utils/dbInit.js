'use strict';

import { getMongoDatabase, initializeMongo } from '../mongo.js';

const DB_CHECK_TIMEOUT_MS = 8_000;
export const REQUIRED_COLLECTIONS = ['users', 'interaction_sessions'];
export const OPTIONAL_COLLECTIONS = [];

export async function initializeDatabase() {
    const result = Object.fromEntries([
        ...REQUIRED_COLLECTIONS,
        ...OPTIONAL_COLLECTIONS
    ].map(name => [name, false]));

    try {
        await Promise.race([
            initializeMongo(),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error('MongoDB connection check timed out.')), DB_CHECK_TIMEOUT_MS);
            })
        ]);

        const db = getMongoDatabase();
        const existingCollections = new Set(
            (await db.listCollections({}, { nameOnly: true }).toArray()).map(collection => collection.name)
        );

        for (const name of REQUIRED_COLLECTIONS) {
            if (!existingCollections.has(name)) {
                await db.createCollection(name);
            }
            result[name] = true;
        }

        for (const name of OPTIONAL_COLLECTIONS) {
            result[name] = existingCollections.has(name);
        }

        result.allReady = true;
        console.log('MongoDB initialization check passed - all required collections are ready.');
    } catch (error) {
        result.allReady = false;
        console.warn(`MongoDB initialization check failed: ${error?.message || error}`);
        console.warn('Set MONGODB_URI (and optionally MONGODB_DATABASE) in .env and ensure the database is reachable.');
    }

    return result;
}

export async function isDatabaseReady() {
    return (await initializeDatabase()).allReady;
}

export async function safeDbOperation(operation, fallback = null) {
    try {
        return await operation();
    } catch (error) {
        console.error('Database operation failed:', error?.message || error);
        return fallback;
    }
}

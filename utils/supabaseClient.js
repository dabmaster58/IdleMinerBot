'use strict';

import { getMongoDatabase } from '../mongo.js';

export function getSupabaseClient() {
    return getMongoDatabase();
}

const supabase = new Proxy({}, {
    get(_target, property) {
        const db = getMongoDatabase();
        const value = db[property];
        return typeof value === 'function' ? value.bind(db) : value;
    }
});

export default supabase;

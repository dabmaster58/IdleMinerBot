'use strict';

import { getMongoDatabase } from './mongo.js';

export function getSupabaseClient() {
    return getMongoDatabase();
}

export default { getSupabaseClient };

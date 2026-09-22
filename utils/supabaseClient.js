import { getMongoDatabase } from '../mongo.js';
export function getDatabase() { return getMongoDatabase(); }
export default { getDatabase };

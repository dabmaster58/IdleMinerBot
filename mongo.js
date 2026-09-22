'use strict';

import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

let client;
let database;

export function getMongoDatabase() {
    if (database) return database;
    const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
    const name = process.env.MONGODB_DATABASE || process.env.MONGO_DATABASE || 'idleminerbot';
    if (!uri) throw new Error('MongoDB is not configured. Set MONGODB_URI and optionally MONGODB_DATABASE in your .env file.');
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
    database = client.db(name);
    return database;
}

export async function initializeMongo() {
    const db = getMongoDatabase();
    await db.command({ ping: 1 });
    await Promise.all([
        db.collection('users').createIndex({ id: 1 }, { unique: true }),
        db.collection('interaction_sessions').createIndex({ id: 1 }, { unique: true }),
        db.collection('users').createIndex({ 'data.user_id': 1 })
    ]);
    return db;
}

export async function closeMongo() {
    if (client) await client.close();
    client = null;
    database = null;
}

export default { getMongoDatabase, initializeMongo, closeMongo };

'use strict';

import { getMongoDatabase } from '../mongo.js';
import { ActivityType } from 'discord.js';
let lastKnownUserCount = null;
const buildStatusText = count => `${count} ${count === 1 ? 'user is' : 'users are'} mining!`;
export async function updateBotStatus(client) {
    if (!client?.user) return false;
    try {
        const count = await getMongoDatabase().collection('users').countDocuments();
        lastKnownUserCount = count;
        const text = buildStatusText(count);
        if (typeof client.user.setActivity === 'function') await client.user.setActivity(text, { type: ActivityType.Playing });
        else if (typeof client.user.setPresence === 'function') await client.user.setPresence({ status: 'online', activities: [{ name: text, type: ActivityType.Playing }] });
        return true;
    } catch {
        try { const text = lastKnownUserCount === null ? 'Waiting for miners...' : buildStatusText(lastKnownUserCount); await client.user.setActivity(text, { type: ActivityType.Playing }); } catch {}
        return false;
    }
}
export function resetBotStatusForTests() { lastKnownUserCount = null; }
export default { updateBotStatus, resetBotStatusForTests };

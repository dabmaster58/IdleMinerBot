import { getMongoDatabase } from '../../mongo.js';
import { getUser, updateUser, updateUserTransaction, removeTestUsers } from '../../dataManager.js';
import { initializeDatabase } from '../../utils/dbInit.js';
import { isOwner, ownerDeniedMessage } from '../../utils/ownerTools.js';

async function reply(message, content) {
    if (typeof message?.reply === 'function') return message.reply(content);
    return message?.channel?.send?.(content);
}

function parsePositiveNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function formatUser(user, userId) {
    if (!user) return `No player data found for \`${userId}\`.`;
    return [
        `**${user.username || 'Unknown'}** (\`${user.user_id || user.userId || userId}\`)`,
        `Cash: ${user.cash ?? 0}`,
        `Super cash: ${user.super_cash ?? 0}`,
        `Premium: ${user.has_premium ? 'yes' : 'no'}`,
        `Mines: ${Array.isArray(user.mines) ? user.mines.length : 0}`
    ].join('\n');
}

async function executeOwnerTool(message, args = []) {
    if (!isOwner(message?.author)) return reply(message, ownerDeniedMessage());

    const [action = 'help', rawTarget, rawValue] = args;
    const target = rawTarget?.replace(/[<@!>]/g, '');

    try {
        if (action === 'help') {
            return reply(message, [
                '**Owner tools**',
                '`im!owner stats` — database counts',
                '`im!owner user <discord-id>` — inspect a player',
                '`im!owner grant <discord-id> <amount>` — add cash',
                '`im!owner premium <discord-id> [on|off]` — change premium status',
                '`im!owner cleantest` — remove non-Discord test users',
                '`im!owner dbcheck` — verify MongoDB connectivity'
            ].join('\n'));
        }

        if (action === 'stats') {
            const db = getMongoDatabase();
            const [users, sessions] = await Promise.all([
                db.collection('users').countDocuments(),
                db.collection('interaction_sessions').countDocuments()
            ]);
            return reply(message, `MongoDB stats:\nUsers: **${users}**\nInteraction sessions: **${sessions}**`);
        }

        if (action === 'dbcheck') {
            const status = await initializeDatabase();
            return reply(message, `MongoDB is ${status.allReady ? '**ready**' : '**not ready**'}.`);
        }

        if (action === 'cleantest') {
            const removed = await removeTestUsers();
            return reply(message, `Removed **${removed}** test user record(s).`);
        }

        if (!target) return reply(message, 'Provide a Discord user ID or mention.');

        if (action === 'user') {
            return reply(message, formatUser(await getUser(target), target));
        }

        if (action === 'grant') {
            const amount = parsePositiveNumber(rawValue, NaN);
            if (!Number.isFinite(amount) || amount <= 0) return reply(message, 'Provide a positive cash amount.');
            const result = await updateUserTransaction(target, user => {
                if (!user) return undefined;
                user.cash = Number(user.cash || 0) + amount;
                return user;
            });
            return reply(message, result.committed ? `Granted **${amount}** cash to <@${target}>.` : `No player data found for \`${target}\`.`);
        }

        if (action === 'premium') {
            const enabled = String(rawValue || 'on').toLowerCase() !== 'off';
            const user = await getUser(target);
            if (!user) return reply(message, `No player data found for \`${target}\`.`);
            await updateUser(target, { has_premium: enabled });
            return reply(message, `Premium ${enabled ? 'enabled' : 'disabled'} for <@${target}>.`);
        }

        return reply(message, `Unknown owner tool \`${action}\`. Use \`im!owner help\`.`);
    } catch (error) {
        console.error('Owner tool failed:', error?.message || error);
        return reply(message, `Owner tool failed: ${error?.message || 'database error'}`);
    }
}

export default {
    name: 'owner',
    description: 'Owner-only administration tools.',
    aliases: ['admin', 'tools'],
    execute: executeOwnerTool
};

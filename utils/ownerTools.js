export const OWNER_ID = '896759022177374250';

export function isOwner(userOrId) {
    const id = typeof userOrId === 'string' ? userOrId : userOrId?.id;
    return String(id || '') === OWNER_ID;
}

export function ownerDeniedMessage() {
    return 'This command is restricted to the bot owner.';
}
